import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ── Canonical tier config (single source of truth) ──
const TIER_CONFIG: Record<string, {
  priceId: string; productId: string; name: string;
  accountSize: number; entryFee: number; isLive: boolean;
  firstPayoutCap: number; splitPercent: number; lifetimeCapMultiple: number;
}> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
    name: 'Starter Evaluation',
    accountSize: 50_000, entryFee: 149, isLive: true,
    firstPayoutCap: 300, splitPercent: 80, lifetimeCapMultiple: 7,
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
    name: 'Pro Evaluation',
    accountSize: 100_000, entryFee: 199, isLive: false,
    firstPayoutCap: 500, splitPercent: 82, lifetimeCapMultiple: 9,
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
    name: 'Elite Evaluation',
    accountSize: 200_000, entryFee: 349, isLive: false,
    firstPayoutCap: 750, splitPercent: 85, lifetimeCapMultiple: 12,
  },
}

interface CheckResult { ok: boolean; detail: string; verifyUnavailable?: boolean }
interface Blocker { key: string; severity: 'warning' | 'blocking'; detail: string }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── Auth: admin only ──
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json(401, { error: 'Unauthorized' })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user?.id) return json(401, { error: 'Invalid token' })

    const { data: roleRow } = await supabase
      .from('user_roles').select('role')
      .eq('user_id', userData.user.id).eq('role', 'admin')
      .maybeSingle()
    if (!roleRow) return json(403, { error: 'Admin access required' })

    // ── Service client for privileged reads ──
    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const url = new URL(req.url)
    const deep = url.searchParams.get('deep') === '1'

    // ── Parallel data fetches ──
    const [
      cohortsRes,
      breakerRes,
      snapshotRes,
      paymentStateRes,
      reserveGateRes,
      liabilityRes,
      reconRes,
      auditFailRes,
    ] = await Promise.all([
      svc.from('cohorts').select('id, name, cohort_phase, is_active, entry_fee, tier_id').eq('is_active', true),
      svc.from('econ_breaker_state').select('*').limit(1).maybeSingle(),
      svc.from('risk_snapshots').select('net_buffer, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      svc.from('payment_system_state').select('is_paused_inbound, pause_reason').limit(1).maybeSingle(),
      svc.from('system_settings').select('value').eq('key', 'reserve_aware_approval').maybeSingle(),
      svc.rpc('get_liability_snapshot', { _days_forward: 7, _cash_reserve: 0, _assumed_avg_first_payout: 300 }),
      svc.from('reconciliation_runs').select('id, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      svc.from('audit_logs').select('id').eq('action', 'reconciliation_failed').gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(5),
    ])

    const activeCohorts = cohortsRes.data || []
    const breaker = breakerRes.data
    const snapshot = snapshotRes.data
    const liability = liabilityRes.data as any

    // ── Load persisted buffer settings ──
    const settingsRes = await svc.rpc('get_liability_buffer_settings')
    const bufSettings = settingsRes.data as any
    const cashReserve = bufSettings?.cash_reserve ?? 0
    const assumedAvgPayout = bufSettings?.assumed_avg_first_payout ?? 300

    // Re-fetch liability with actual settings if they differ
    let liabilityData = liability
    if (cashReserve !== 0 || assumedAvgPayout !== 300) {
      const reRes = await svc.rpc('get_liability_snapshot', {
        _days_forward: 7,
        _cash_reserve: cashReserve,
        _assumed_avg_first_payout: assumedAvgPayout,
      })
      if (!reRes.error) liabilityData = reRes.data as any
    }

    // ── Stripe deep verify (optional) ──
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const stripeKeyPresent = !!stripeKey && stripeKey.length > 10
    let stripeDeep: Record<string, { priceValid: boolean; productValid: boolean; priceMatchesProduct: boolean; error?: string }> = {}

    if (deep && stripeKeyPresent) {
      try {
        const stripe = new Stripe(stripeKey!)
        for (const [id, cfg] of Object.entries(TIER_CONFIG)) {
          try {
            const [price, product] = await Promise.all([
              stripe.prices.retrieve(cfg.priceId).catch(() => null),
              stripe.products.retrieve(cfg.productId).catch(() => null),
            ])
            const priceProductId = price
              ? (typeof price.product === 'string' ? price.product : (price.product as any)?.id)
              : null
            stripeDeep[id] = {
              priceValid: !!price && (price as any).active === true,
              productValid: !!product,
              priceMatchesProduct: priceProductId === cfg.productId,
            }
          } catch (e) {
            stripeDeep[id] = { priceValid: false, productValid: false, priceMatchesProduct: false, error: (e as Error).message }
          }
        }
      } catch { /* init failed */ }
    }

    // ── Build tier readiness ──
    const tiers = Object.entries(TIER_CONFIG).map(([id, cfg]) => {
      const hasPriceId = cfg.priceId?.startsWith('price_')
      const hasProductId = cfg.productId?.startsWith('prod_')
      const dr = deep ? stripeDeep[id] : null
      const verifyUnavailable = !!dr?.error

      const purchasable: CheckResult = { ok: cfg.isLive, detail: cfg.isLive ? 'Live' : 'isLive=false' }

      let stripeOk = hasPriceId && hasProductId && stripeKeyPresent
      let stripeDetail = 'Config present'
      if (dr) {
        stripeOk = dr.priceValid && dr.productValid && dr.priceMatchesProduct && stripeKeyPresent
        stripeDetail = dr.error ? `Verify failed: ${dr.error}` : stripeOk ? 'Verified active in Stripe' : 'Stripe mismatch'
      }
      const stripeWired: CheckResult = { ok: stripeOk, detail: stripeDetail, verifyUnavailable }

      const matchingCohort = activeCohorts.find(c => c.tier_id === id || (!c.tier_id && c.entry_fee === cfg.entryFee))
      const cohortReady: CheckResult = {
        ok: !!matchingCohort,
        detail: matchingCohort ? `${matchingCohort.name} (${matchingCohort.cohort_phase})` : 'No active cohort',
      }

      const gateOk = cfg.isLive && stripeOk && !verifyUnavailable
      const serverGateOk: CheckResult = {
        ok: gateOk,
        detail: !cfg.isLive ? 'TIER_NOT_LIVE' : verifyUnavailable ? 'Verify unavailable — locked' : gateOk ? 'Gate open' : 'Blocked',
        verifyUnavailable,
      }

      return { id, name: cfg.name, isLive: cfg.isLive, entryFee: cfg.entryFee, checks: { purchasable, stripeWired, cohortReady, serverGateOk } }
    })

    // ── Build cohort profitability ──
    const cohortHealth = activeCohorts.map(c => {
      const cohortLiability = (liabilityData?.by_cohort || []).find((lc: any) => lc.cohort_id === c.id)
      const pendingAmount = cohortLiability?.pending_amount ?? 0
      const approvedUnpaid = cohortLiability?.approved_unpaid ?? 0
      const netBuffer = cashReserve - pendingAmount - approvedUnpaid
      return {
        id: c.id, name: c.name, tier_id: c.tier_id,
        cash_reserve: cashReserve,
        pending_liability: pendingAmount + approvedUnpaid,
        opening_soon_liability: liabilityData?.expected_opening_soon_liability ?? 0,
        net_buffer: netBuffer,
        ok: netBuffer >= 0,
        detail: netBuffer >= 0 ? 'Buffer positive' : `Shortfall: $${Math.abs(Math.round(netBuffer))}`,
      }
    })

    // ── Audit health ──
    const snapAge = snapshot?.created_at
      ? (Date.now() - new Date(snapshot.created_at).getTime()) / (1000 * 60 * 60)
      : null
    const reconAge = reconRes.data?.created_at
      ? (Date.now() - new Date(reconRes.data.created_at).getTime()) / (1000 * 60 * 60)
      : null
    const failuresLast24h = auditFailRes.data?.length ?? 0

    const auditOk = (snapAge !== null && snapAge < 26) && failuresLast24h === 0
    const audits = {
      ok: auditOk,
      lastSnapshotAt: snapshot?.created_at ?? null,
      lastReconAt: reconRes.data?.created_at ?? null,
      snapshotAgeHours: snapAge !== null ? Math.round(snapAge) : null,
      reconAgeHours: reconAge !== null ? Math.round(reconAge) : null,
      failuresLast24h,
      detail: !snapshot?.created_at ? 'No risk snapshot found'
        : snapAge! > 26 ? `Snapshot stale (${Math.round(snapAge!)}h old)`
        : failuresLast24h > 0 ? `${failuresLast24h} failed audits in 24h`
        : 'Healthy',
    }

    // ── Compute blockers (fail-closed) ──
    const blockers: Blocker[] = []

    // Tier blockers (only for live tiers)
    for (const t of tiers) {
      if (!t.isLive) continue
      if (!t.checks.stripeWired.ok) {
        blockers.push({ key: `tier_stripe_${t.id}`, severity: 'blocking', detail: `${t.name}: Stripe not wired — ${t.checks.stripeWired.detail}` })
      }
      if (t.checks.stripeWired.verifyUnavailable) {
        blockers.push({ key: `tier_verify_${t.id}`, severity: 'blocking', detail: `${t.name}: Stripe verification unavailable — cannot certify flip safety` })
      }
      if (!t.checks.cohortReady.ok) {
        blockers.push({ key: `tier_cohort_${t.id}`, severity: 'blocking', detail: `${t.name}: ${t.checks.cohortReady.detail}` })
      }
      if (!t.checks.serverGateOk.ok) {
        blockers.push({ key: `tier_gate_${t.id}`, severity: 'blocking', detail: `${t.name}: Server gate blocked — ${t.checks.serverGateOk.detail}` })
      }
    }

    // Check upcoming tiers aren't accidentally purchasable
    for (const t of tiers) {
      if (!t.isLive && t.checks.serverGateOk.ok) {
        blockers.push({ key: `upcoming_leak_${t.id}`, severity: 'blocking', detail: `${t.name}: isLive=false but server gate reports OK — potential leak` })
      }
    }

    // Breaker
    if (!breaker) {
      blockers.push({ key: 'breaker_missing', severity: 'blocking', detail: 'Breaker state not found' })
    } else if (breaker.breaker_level !== 'normal') {
      blockers.push({ key: 'breaker_active', severity: 'blocking', detail: `Breaker: ${breaker.breaker_level}` })
    }

    // Net buffer
    const globalNetBuffer = liabilityData?.net_buffer ?? null
    if (globalNetBuffer === null) {
      blockers.push({ key: 'buffer_missing', severity: 'blocking', detail: 'Liability snapshot unavailable' })
    } else if (globalNetBuffer <= 0) {
      blockers.push({ key: 'buffer_negative', severity: 'blocking', detail: `Net buffer: $${Math.round(globalNetBuffer)}` })
    }

    // Payment system
    const ps = paymentStateRes.data
    if (!ps) {
      blockers.push({ key: 'payment_state_missing', severity: 'blocking', detail: 'Payment system state not found' })
    } else if (ps.is_paused_inbound) {
      blockers.push({ key: 'inbound_paused', severity: 'blocking', detail: ps.pause_reason ? `Inbound paused: ${ps.pause_reason}` : 'Inbound payments paused' })
    }

    // Reserve gate
    const rg = reserveGateRes.data?.value as any
    const reserveEnabled = rg?.enabled === true
    const hasSimRun = !!rg?.last_simulation_run_id
    if (!reserveEnabled || !hasSimRun) {
      blockers.push({ key: 'reserve_gate', severity: 'blocking', detail: 'Reserve gate not configured or missing simulation run' })
    }

    // Audit health
    if (!audits.ok) {
      blockers.push({
        key: 'audit_health',
        severity: audits.failuresLast24h > 0 ? 'blocking' : 'warning',
        detail: audits.detail,
      })
    }

    const safeToSell = blockers.filter(b => b.severity === 'blocking').length === 0

    return json(200, {
      checkedAt: new Date().toISOString(),
      deep,
      safeToSell,
      blockers,
      tiers,
      cohorts: cohortHealth,
      audits,
      liability: {
        cashReserve,
        assumedAvgPayout,
        totalPending: liabilityData?.total_pending_amount ?? 0,
        approvedUnpaid: liabilityData?.approved_unpaid ?? 0,
        openingSoonCount: liabilityData?.opening_soon_count ?? 0,
        openingSoonLiability: liabilityData?.expected_opening_soon_liability ?? 0,
        netBuffer: globalNetBuffer,
      },
    })
  } catch (err) {
    console.error('get-admin-readiness error:', err)
    return json(500, { error: (err as Error).message })
  }
})