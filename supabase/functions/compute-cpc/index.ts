import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Score helpers ──

/** Realized margin sub-score (0–1). Positive = 1.0, slightly negative degrades linearly */
function scoreRealizedMargin(revenue: number, payouts: number): number {
  if (revenue === 0) return 0.5 // no data yet
  const margin = revenue - payouts
  const ratio = margin / revenue
  if (ratio >= 0.3) return 1.0
  if (ratio >= 0) return 0.7 + (ratio / 0.3) * 0.3
  // Negative margin
  if (ratio >= -0.5) return Math.max(0, 0.7 + ratio * 1.4)
  return 0
}

/** Buffer coverage sub-score (0–1). Coverage = netBuffer / max(liability, 1) */
function scoreBufferCoverage(netBuffer: number | null, liability: number): number {
  if (netBuffer === null) return 0.3 // unknown = pessimistic
  const effective = Math.max(liability, 1)
  const ratio = netBuffer / effective
  if (ratio >= 3) return 1.0
  if (ratio >= 2) return 0.85
  if (ratio >= 1) return 0.65
  if (ratio >= 0) return ratio * 0.65
  return 0
}

/** Pass rate sub-score (0–1). In-band = ≤15%. Structural break = 35%+ */
function scorePassRate(passRate: number | null): number {
  if (passRate === null) return 0.5 // no data
  const pct = passRate * 100
  if (pct <= 10) return 1.0
  if (pct <= 15) return 0.8
  if (pct <= 20) return 0.6
  if (pct <= 30) return 0.3
  return 0 // ≥30% structural risk
}

/** CPC band from weighted score */
function cpcBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.80) return 'high'
  if (score >= 0.60) return 'medium'
  return 'low'
}

// ── Main handler ──

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const cronSecret = Deno.env.get('CRON_SECRET')
    let source: 'manual' | 'cron' = 'manual'
    let isAuthorized = false

    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      isAuthorized = true
      source = 'cron'
    }

    if (!isAuthorized && authHeader?.startsWith('Bearer ')) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      )
      const { data: userData } = await supabase.auth.getUser()
      if (userData?.user?.id) {
        const { data: roleRow } = await supabase
          .from('user_roles').select('role')
          .eq('user_id', userData.user.id).eq('role', 'admin')
          .maybeSingle()
        if (roleRow) {
          isAuthorized = true
          source = 'manual'
        }
      }
    }

    if (!isAuthorized) return json(401, { error: 'Unauthorized' })

    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Parallel fetch all inputs
    const [revenueRes, payoutsRes, breakerRes, liabilitySettingsRes, pendingRes] = await Promise.all([
      // Revenue = successful inbound payment transactions (last 30d)
      svc.from('payment_transactions')
        .select('amount')
        .eq('direction', 'inbound')
        .eq('status', 'completed')
        .gte('created_at', thirtyDaysAgo),
      // Payouts paid out (last 30d)
      svc.from('payouts')
        .select('amount')
        .in('status', ['paid', 'paid_confirmed'])
        .gte('paid_at', thirtyDaysAgo),
      // Breaker state
      svc.from('econ_breaker_state').select('*').limit(1).maybeSingle(),
      // Liability buffer settings
      svc.rpc('get_liability_buffer_settings'),
      // Pending + in-flight payouts (forward liability)
      svc.from('payouts')
        .select('amount')
        .in('status', ['pending', 'under_review', 'approved', 'payment_initiated']),
    ])

    const revenue30d = (revenueRes.data || []).reduce((s, r) => s + Number(r.amount || 0), 0)
    const payouts30d = (payoutsRes.data || []).reduce((s, p) => s + Number(p.amount || 0), 0)
    const pendingLiability = (pendingRes.data || []).reduce((s, p) => s + Number(p.amount || 0), 0)

    const breaker = breakerRes.data
    const passRate = breaker?.rolling_pass_rate ?? null
    const breakerLevel = breaker?.breaker_level ?? 'normal'

    // Get net buffer from liability snapshot
    const bufSettings = liabilitySettingsRes.data as any
    const cashReserve = bufSettings?.cash_reserve ?? 0
    const assumedAvg = bufSettings?.assumed_avg_first_payout ?? 300

    const liabilityRes = await svc.rpc('get_liability_snapshot', {
      _days_forward: 7,
      _cash_reserve: cashReserve,
      _assumed_avg_first_payout: assumedAvg,
    })
    const netBuffer = (liabilityRes.data as any)?.net_buffer ?? null

    // Compute sub-scores
    const realizedMarginScore = scoreRealizedMargin(revenue30d, payouts30d)
    const bufferCoverageRatio = netBuffer !== null ? netBuffer / Math.max(pendingLiability, 1) : 0
    const bufferCoverageScore = scoreBufferCoverage(netBuffer, pendingLiability)
    const passRateScore = scorePassRate(passRate)
    const monteCarloScore = 1.0 // Phase 2: integrate Monte Carlo stress
    const monteCarloRuinPct = 0 // Phase 2

    // Breaker penalty: if elevated/critical, drop one tier worth
    const breakerPenalty = breakerLevel !== 'normal'
    const breakerAdjustment = breakerPenalty ? -0.15 : 0

    // Weighted CPC score
    const rawScore =
      realizedMarginScore * 0.30 +
      bufferCoverageScore * 0.25 +
      monteCarloScore * 0.25 +
      passRateScore * 0.20

    const score = Math.max(0, Math.min(1, rawScore + breakerAdjustment))
    const band = cpcBand(score)

    const result = {
      score: Math.round(score * 100) / 100,
      band,
      realizedMargin: Math.round(revenue30d - payouts30d),
      realizedMarginScore: Math.round(realizedMarginScore * 100) / 100,
      bufferCoverageRatio: Math.round(bufferCoverageRatio * 100) / 100,
      bufferCoverageScore: Math.round(bufferCoverageScore * 100) / 100,
      passRate: passRate !== null ? Math.round(passRate * 10000) / 100 : null,
      passRateScore: Math.round(passRateScore * 100) / 100,
      monteCarloRuinPct,
      monteCarloScore,
      breakerLevel,
      breakerPenalty,
      revenue30d: Math.round(revenue30d),
      payouts30d: Math.round(payouts30d),
      pendingLiability: Math.round(pendingLiability),
      netBuffer: netBuffer !== null ? Math.round(netBuffer) : null,
      source,
      computedAt: new Date().toISOString(),
    }

    // Persist snapshot
    await svc.from('cpc_snapshots').insert({
      score: result.score,
      band: result.band,
      realized_margin: result.realizedMargin,
      realized_margin_score: result.realizedMarginScore,
      buffer_coverage_ratio: result.bufferCoverageRatio,
      buffer_coverage_score: result.bufferCoverageScore,
      pass_rate: passRate ?? 0,
      pass_rate_score: result.passRateScore,
      monte_carlo_ruin_pct: result.monteCarloRuinPct,
      monte_carlo_score: result.monteCarloScore,
      breaker_level: result.breakerLevel,
      breaker_penalty: result.breakerPenalty,
      revenue_30d: result.revenue30d,
      payouts_30d: result.payouts30d,
      pending_liability: result.pendingLiability,
      net_buffer: result.netBuffer,
      source: result.source,
      details: result,
    })

    // Alert on band drop
    const prevRes = await svc
      .from('cpc_snapshots')
      .select('band')
      .order('computed_at', { ascending: false })
      .range(1, 1) // second-most-recent (we just inserted the latest)
      .maybeSingle()

    const prevBand = prevRes.data?.band
    const bandOrder = { high: 2, medium: 1, low: 0 }
    if (prevBand && bandOrder[band as keyof typeof bandOrder] < bandOrder[prevBand as keyof typeof bandOrder]) {
      await svc.from('staff_notifications').insert({
        category: 'cpc',
        severity: band === 'low' ? 'critical' : 'warning',
        title: `📉 CPC dropped: ${prevBand.toUpperCase()} → ${band.toUpperCase()} (${result.score})`,
        body: `Margin: $${result.realizedMargin.toLocaleString()} | Buffer: ${result.bufferCoverageRatio}× | Pass rate: ${result.passRate ?? '—'}%`,
        dedup_key: `cpc-drop-${new Date().toISOString().slice(0, 13)}`,
      })
    }

    // Cleanup > 90 days
    await svc
      .from('cpc_snapshots')
      .delete()
      .lt('computed_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())

    return json(200, result)
  } catch (err) {
    console.error('compute-cpc error:', err)
    return json(500, { error: (err as Error).message })
  }
})
