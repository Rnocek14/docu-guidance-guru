import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'
import { TIER_ECONOMICS, TIER_STRIPE } from '../_shared/checkout/tier-economics.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// Merged config for internal use (economics + stripe)
const TIER_CONFIG = Object.fromEntries(
  Object.entries(TIER_ECONOMICS).map(([id, econ]) => [id, {
    ...econ,
    priceId: TIER_STRIPE[id]?.priceId ?? '',
    productId: TIER_STRIPE[id]?.productId ?? '',
  }])
)

interface CheckResult { ok: boolean; detail: string; verifyUnavailable?: boolean }
interface Blocker { key: string; severity: 'warning' | 'blocking'; detail: string }

interface DeepResult {
  verifyRan: boolean
  verifyUnavailable: boolean
  priceValid: boolean
  productValid: boolean
  priceMatchesProduct: boolean
  verifyError?: string
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Safely parse system_settings.value which may be JSONB, string, or null */
function parseSettingsValue(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
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
    const hasAnyLiveTier = Object.values(TIER_CONFIG).some(t => t.isLive)

    // ── Step 1: Fetch buffer settings FIRST (fix #7 — single RPC call) ──
    const settingsRes = await svc.rpc('get_liability_buffer_settings')
    const bufSettings = settingsRes.data as any
    const cashReserve = bufSettings?.cash_reserve ?? 0
    const assumedAvgPayout = bufSettings?.assumed_avg_first_payout ?? 300

    // ── Step 2: Parallel data fetches (liability uses real settings) ──
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
      // Fix #7: single call with actual settings
      svc.rpc('get_liability_snapshot', {
        _days_forward: 7,
        _cash_reserve: cashReserve,
        _assumed_avg_first_payout: assumedAvgPayout,
      }),
      svc.from('reconciliation_runs').select('id, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      svc.from('audit_logs').select('id').eq('action', 'reconciliation_failed').gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(5),
    ])

    const activeCohorts = cohortsRes.data || []
    const breaker = breakerRes.data
    const snapshot = snapshotRes.data
    const liabilityData = liabilityRes.data as any

    // ── Stripe deep verify (optional) ──
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const stripeKeyPresent = !!stripeKey && stripeKey.length > 10

    // Fix #4: rich per-tier deep status
    const stripeDeep: Record<string, DeepResult> = {}
    let stripeInitFailed = false

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
              verifyRan: true,
              verifyUnavailable: false,
              priceValid: !!price && (price as any).active === true,
              productValid: !!product,
              priceMatchesProduct: priceProductId === cfg.productId,
            }
          } catch (e) {
            stripeDeep[id] = {
              verifyRan: true,
              verifyUnavailable: true,
              priceValid: false,
              productValid: false,
              priceMatchesProduct: false,
              verifyError: (e as Error).message,
            }
          }
        }
      } catch (e) {
        console.error('Stripe init failed:', e)
        stripeInitFailed = true
        // Mark all tiers as verify-unavailable
        for (const id of Object.keys(TIER_CONFIG)) {
          stripeDeep[id] = {
            verifyRan: false,
            verifyUnavailable: true,
            priceValid: false,
            productValid: false,
            priceMatchesProduct: false,
            verifyError: 'Stripe client init failed',
          }
        }
      }
    } else if (deep && !stripeKeyPresent) {
      // Fix #4: deep requested but key missing
      for (const id of Object.keys(TIER_CONFIG)) {
        stripeDeep[id] = {
          verifyRan: false,
          verifyUnavailable: true,
          priceValid: false,
          productValid: false,
          priceMatchesProduct: false,
          verifyError: 'STRIPE_SECRET_KEY not configured',
        }
      }
    }

    // ── Build per-tier readiness ──
    const tiers = Object.entries(TIER_CONFIG).map(([id, cfg]) => {
      const hasPriceId = cfg.priceId?.startsWith('price_')
      const hasProductId = cfg.productId?.startsWith('prod_')
      const dr = stripeDeep[id] ?? null

      const purchasable: CheckResult = { ok: cfg.isLive, detail: cfg.isLive ? 'Live' : 'isLive=false' }

      // Stripe wired check
      let stripeOk: boolean
      let stripeDetail: string
      let verifyUnavailable = false

      if (dr?.verifyRan || dr?.verifyUnavailable) {
        verifyUnavailable = dr.verifyUnavailable
        if (dr.verifyUnavailable) {
          stripeOk = false
          stripeDetail = `Verify unavailable: ${dr.verifyError ?? 'unknown'}`
        } else {
          stripeOk = dr.priceValid && dr.productValid && dr.priceMatchesProduct && stripeKeyPresent
          stripeDetail = stripeOk ? 'Verified active in Stripe' : 'Stripe mismatch — check price/product'
        }
      } else {
        stripeOk = hasPriceId && hasProductId && stripeKeyPresent
        stripeDetail = !stripeKeyPresent ? 'STRIPE_SECRET_KEY missing' : stripeOk ? 'Config present (run deep verify)' : 'Missing price/product IDs'
      }
      const stripeWired: CheckResult = { ok: stripeOk, detail: stripeDetail, verifyUnavailable }

      // Cohort check
      const matchingCohort = activeCohorts.find(c => c.tier_id === id || (!c.tier_id && c.entry_fee === cfg.entryFee))
      const cohortReady: CheckResult = {
        ok: !!matchingCohort,
        detail: matchingCohort ? `${matchingCohort.name} (${matchingCohort.cohort_phase})` : 'No active cohort',
      }

      // Server gate — for live tiers, all must pass; for upcoming, label as expected (not verified)
      const gateOk = cfg.isLive && stripeOk && !verifyUnavailable
      const serverGateOk: CheckResult = {
        ok: cfg.isLive ? gateOk : true,
        detail: !cfg.isLive
          ? 'Expected: TIER_NOT_LIVE (not probed)'
          : verifyUnavailable ? 'Verify unavailable — gate locked'
          : gateOk ? 'Gate open' : 'Blocked',
        verifyUnavailable: cfg.isLive ? verifyUnavailable : false,
      }

      // Fix #1: compute "wouldPassGateIfLive" for leak detection
      const wouldPassIfLive = stripeOk && !verifyUnavailable
      const configLiveReady = !cfg.isLive && wouldPassIfLive

      return {
        id, name: cfg.name, isLive: cfg.isLive, entryFee: cfg.entryFee,
        configLiveReady, // UI can show "config ready, ensure server blocks"
        checks: { purchasable, stripeWired, cohortReady, serverGateOk },
      }
    })

    // ── Build cohort exposure (fix #2/#3: global buffer only, per-cohort is exposure breakdown) ──
    const cohortExposure = activeCohorts.map(c => {
      const cohortLiability = (liabilityData?.by_cohort || []).find((lc: any) => lc.cohort_id === c.id)
      const pendingAmount = cohortLiability?.pending_amount ?? 0
      const approvedUnpaid = cohortLiability?.approved_unpaid ?? 0
      return {
        id: c.id, name: c.name, tier_id: c.tier_id,
        pending_amount: pendingAmount,
        approved_unpaid: approvedUnpaid,
        total_exposure: pendingAmount + approvedUnpaid,
        pending_count: cohortLiability?.pending_count ?? 0,
        approved_count: cohortLiability?.approved_count ?? 0,
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

    // ── Fix #8: normalize reserve gate value ──
    const rgRaw = reserveGateRes.data?.value
    const rg = parseSettingsValue(rgRaw)
    const reserveEnabled = rg?.enabled === true
    const hasSimRun = !!rg?.last_simulation_run_id

    // ── Compute blockers (fail-closed) ──
    const blockers: Blocker[] = []

    // Fix #5: enforce deep verification for live tiers
    if (hasAnyLiveTier && !deep) {
      blockers.push({
        key: 'deep_required',
        severity: 'blocking',
        detail: 'Deep Stripe verification required for live tiers — enable Deep Verify',
      })
    }

    // Tier blockers (only for live tiers)
    for (const t of tiers) {
      if (!t.isLive) {
        // Fix #1: upgraded leak detection
        if (t.configLiveReady) {
          blockers.push({
            key: `upcoming_ready_${t.id}`,
            severity: 'warning',
            detail: `${t.name}: Config is live-ready (Stripe valid) — ensure server blocks with TIER_NOT_LIVE`,
          })
        }
        continue
      }
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

    // Breaker
    if (!breaker) {
      blockers.push({ key: 'breaker_missing', severity: 'blocking', detail: 'Breaker state not found' })
    } else if (breaker.breaker_level !== 'normal') {
      blockers.push({ key: 'breaker_active', severity: 'blocking', detail: `Breaker: ${breaker.breaker_level}` })
    }

    // Net buffer (global only — fix #2)
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
      cohorts: cohortExposure,
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
    return json(500, { error: 'Internal server error' })
  }
})