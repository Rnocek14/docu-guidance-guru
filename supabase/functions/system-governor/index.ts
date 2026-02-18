import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ── Types ──
interface DomainResult {
  safe: boolean
  signal: 'green' | 'yellow' | 'red'
  checks: { name: string; ok: boolean; detail: string }[]
}

interface GovernorResult {
  verdict: 'safe' | 'not_safe' | 'error'
  capital: DomainResult
  processor: DomainResult
  cohort: DomainResult
  riskEngine: DomainResult
  blockers: { domain: string; detail: string }[]
  autoAction: string
  autoActionDetail: string
  certifiedAt: string
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Parse system_settings value which may be JSONB, string, or null */
function parseSettingsValue(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

// ============================================================================
// DOMAIN EVALUATORS
// ============================================================================

async function evaluateCapitalSafety(svc: any): Promise<DomainResult> {
  const checks: DomainResult['checks'] = []

  // 1. Fetch liability buffer settings
  const settingsRes = await svc.rpc('get_liability_buffer_settings')
  const bufSettings = settingsRes.data as any
  const cashReserve = bufSettings?.cash_reserve ?? 0
  const assumedAvg = bufSettings?.assumed_avg_first_payout ?? 300

  // 2. Liability snapshot
  const liabilityRes = await svc.rpc('get_liability_snapshot', {
    _days_forward: 7,
    _cash_reserve: cashReserve,
    _assumed_avg_first_payout: assumedAvg,
  })
  const ld = liabilityRes.data as any
  const netBuffer = ld?.net_buffer ?? null

  checks.push({
    name: 'Net buffer positive',
    ok: netBuffer !== null && netBuffer > 0,
    detail: netBuffer !== null ? `$${Math.round(netBuffer)}` : 'Unavailable',
  })

  // 3. No stuck payouts > 72h
  const stuckRes = await svc
    .from('payouts')
    .select('id')
    .in('status', ['approved', 'payment_initiated'])
    .lt('requested_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    .limit(1)
  const hasStuck = (stuckRes.data?.length ?? 0) > 0
  checks.push({
    name: 'No stuck payouts > 72h',
    ok: !hasStuck,
    detail: hasStuck ? 'Stuck payout detected' : 'Clear',
  })

  // 4. Cash reserve configured
  checks.push({
    name: 'Cash reserve configured',
    ok: cashReserve > 0,
    detail: cashReserve > 0 ? `$${Math.round(cashReserve)}` : 'Not set',
  })

  const safe = checks.every(c => c.ok)
  return { safe, signal: safe ? 'green' : 'red', checks }
}

async function evaluateProcessorSafety(svc: any): Promise<DomainResult> {
  const checks: DomainResult['checks'] = []

  // 1. Dispute rate — check latest from check-dispute-rate cron runs
  const disputeRes = await svc
    .from('cron_http_runs')
    .select('http_content, http_status')
    .eq('jobname', 'check-dispute-rate')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let disputeOk = false
  let disputeDetail = 'No dispute check data'
  if (disputeRes.data?.http_content) {
    try {
      const parsed = JSON.parse(disputeRes.data.http_content)
      const rate30d = parsed?.windows?.['30d']?.rate ?? null
      if (rate30d !== null) {
        disputeOk = rate30d < 0.005 // 0.5% kill switch threshold
        disputeDetail = `30d rate: ${(rate30d * 100).toFixed(2)}%`
      }
    } catch { /* noop */ }
  }
  checks.push({ name: 'Dispute rate < 0.5%', ok: disputeOk, detail: disputeDetail })

  // 2. Payment system not paused inbound
  const psRes = await svc
    .from('payment_system_state')
    .select('is_paused_inbound, pause_reason')
    .limit(1)
    .maybeSingle()
  const ps = psRes.data
  checks.push({
    name: 'Inbound not paused',
    ok: ps ? !ps.is_paused_inbound : false,
    detail: ps?.is_paused_inbound ? (ps.pause_reason || 'Paused') : (ps ? 'Active' : 'State missing'),
  })

  // 3. Stripe key present
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  const hasKey = !!stripeKey && stripeKey.length > 10
  checks.push({ name: 'Stripe key configured', ok: hasKey, detail: hasKey ? 'Present' : 'Missing' })

  const safe = checks.every(c => c.ok)
  return { safe, signal: safe ? 'green' : checks.some(c => !c.ok && c.name.includes('Dispute')) ? 'red' : 'yellow', checks }
}

async function evaluateCohortSafety(svc: any): Promise<DomainResult> {
  const checks: DomainResult['checks'] = []

  // 1. Active cohorts exist
  const cohortsRes = await svc.from('cohorts').select('id, name, is_active, tier_id').eq('is_active', true)
  const cohorts = cohortsRes.data || []
  checks.push({
    name: 'Active cohorts exist',
    ok: cohorts.length > 0,
    detail: cohorts.length > 0 ? `${cohorts.length} active` : 'None',
  })

  // 2. Pass rate within range (check breaker state)
  const breakerRes = await svc.from('econ_breaker_state').select('*').limit(1).maybeSingle()
  const breaker = breakerRes.data
  const passRate = breaker?.rolling_pass_rate ?? 0
  const passRateOk = passRate <= 0.15 // 15% max safe
  checks.push({
    name: 'Pass rate ≤ 15%',
    ok: passRateOk,
    detail: `${(passRate * 100).toFixed(1)}% (${breaker?.rolling_pass_count ?? 0}/${breaker?.rolling_total_count ?? 0})`,
  })

  // 3. No anomalous pass spike (breaker in normal)
  const breakerNormal = breaker?.breaker_level === 'normal'
  checks.push({
    name: 'Breaker normal',
    ok: breakerNormal,
    detail: breaker?.breaker_level ?? 'Missing',
  })

  const safe = checks.every(c => c.ok)
  return { safe, signal: safe ? 'green' : 'red', checks }
}

async function evaluateRiskEngineSafety(svc: any): Promise<DomainResult> {
  const checks: DomainResult['checks'] = []

  // 1. Risk snapshot freshness (< 26h)
  const snapRes = await svc
    .from('risk_snapshots')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const snapAge = snapRes.data?.created_at
    ? (Date.now() - new Date(snapRes.data.created_at).getTime()) / (1000 * 60 * 60)
    : null
  checks.push({
    name: 'Risk snapshot fresh (< 26h)',
    ok: snapAge !== null && snapAge < 26,
    detail: snapAge !== null ? `${Math.round(snapAge)}h old` : 'Never run',
  })

  // 2. No failed audits in 24h
  const failRes = await svc
    .from('audit_logs')
    .select('id')
    .eq('action', 'reconciliation_failed')
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(5)
  const failures = failRes.data?.length ?? 0
  checks.push({
    name: 'No failed audits (24h)',
    ok: failures === 0,
    detail: failures === 0 ? 'Clear' : `${failures} failure(s)`,
  })

  // 3. Reserve gate configured
  const rgRes = await svc
    .from('system_settings')
    .select('value')
    .eq('key', 'reserve_aware_approval')
    .maybeSingle()
  const rg = parseSettingsValue(rgRes.data?.value)
  const reserveOk = rg?.enabled === true && !!rg?.last_simulation_run_id
  checks.push({
    name: 'Reserve gate active',
    ok: reserveOk,
    detail: reserveOk ? 'Enabled with sim run' : 'Not configured',
  })

  // 4. Cron health — check monitor has run recently
  const cronRes = await svc
    .from('cron_http_runs')
    .select('ran_at, http_status')
    .eq('jobname', 'cron-health-monitor')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const cronAge = cronRes.data?.ran_at
    ? (Date.now() - new Date(cronRes.data.ran_at).getTime()) / (1000 * 60 * 60)
    : null
  checks.push({
    name: 'Cron monitor alive',
    ok: cronAge !== null && cronAge < 2,
    detail: cronAge !== null ? `${Math.round(cronAge * 60)}m ago` : 'Never',
  })

  const safe = checks.every(c => c.ok)
  return { safe, signal: safe ? 'green' : 'red', checks }
}

// ============================================================================
// AUTO-HEAL / AUTO-LOCK
// ============================================================================

async function executeAutoAction(
  svc: any,
  result: GovernorResult,
  config: Record<string, unknown>,
): Promise<{ action: string; detail: string }> {
  const autoLock = config.auto_lock !== false
  const autoUnlock = config.auto_unlock !== false

  if (result.verdict === 'not_safe' && autoLock) {
    // Check if already locked
    const psRes = await svc
      .from('payment_system_state')
      .select('is_paused_inbound, is_paused_outbound')
      .limit(1)
      .maybeSingle()
    const ps = psRes.data

    if (ps && (!ps.is_paused_inbound || !ps.is_paused_outbound)) {
      // Auto-lock: pause inbound and outbound
      await svc
        .from('payment_system_state')
        .update({
          is_paused_inbound: true,
          is_paused_outbound: true,
          pause_reason: `Governor auto-lock: ${result.blockers.map(b => b.detail).join('; ').slice(0, 200)}`,
          paused_at: new Date().toISOString(),
        })
        .eq('id', ps.id || psRes.data?.id)

      // Log to staff_notifications
      await svc.from('staff_notifications').insert({
        category: 'governor',
        severity: 'critical',
        title: '🚨 Governor AUTO-LOCK activated',
        body: `System locked: ${result.blockers.length} blocker(s). ${result.blockers.map(b => b.detail).join('; ')}`,
        dedup_key: `governor-lock-${new Date().toISOString().slice(0, 13)}`, // hourly dedup
      }).single()

      return { action: 'locked', detail: `Auto-locked: ${result.blockers.length} blocking issue(s)` }
    }
    return { action: 'already_locked', detail: 'System already locked' }
  }

  if (result.verdict === 'safe' && autoUnlock) {
    // Check if currently locked by governor
    const psRes = await svc
      .from('payment_system_state')
      .select('is_paused_inbound, is_paused_outbound, pause_reason')
      .limit(1)
      .maybeSingle()
    const ps = psRes.data

    if (ps && (ps.is_paused_inbound || ps.is_paused_outbound)) {
      // Only auto-unlock if it was locked by the governor
      if (ps.pause_reason?.startsWith('Governor auto-lock')) {
        await svc
          .from('payment_system_state')
          .update({
            is_paused_inbound: false,
            is_paused_outbound: false,
            pause_reason: null,
            paused_at: null,
          })
          .eq('id', ps.id)

        await svc.from('staff_notifications').insert({
          category: 'governor',
          severity: 'info',
          title: '✅ Governor AUTO-UNLOCK — all clear',
          body: 'All 4 domains green. System unlocked automatically.',
          dedup_key: `governor-unlock-${new Date().toISOString().slice(0, 13)}`,
        }).single()

        return { action: 'unlocked', detail: 'All domains green — auto-unlocked' }
      }
      return { action: 'none', detail: 'Locked manually (not by governor) — skipping auto-unlock' }
    }
    return { action: 'none', detail: 'System already unlocked' }
  }

  return { action: 'none', detail: 'No auto-action configured or needed' }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Auth: either CRON_SECRET (for cron) or admin JWT
    const authHeader = req.headers.get('Authorization')
    const cronSecret = Deno.env.get('CRON_SECRET')
    let source = 'manual'
    let isAuthorized = false

    // Check cron secret
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      isAuthorized = true
      source = 'cron'
    }

    // Check admin JWT
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

    // Service client for privileged operations
    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch governor config
    const configRes = await svc
      .from('system_settings')
      .select('value')
      .eq('key', 'governor_config')
      .maybeSingle()
    const config = parseSettingsValue(configRes.data?.value)

    // Run all 4 domain evaluations in parallel
    const [capital, processor, cohort, riskEngine] = await Promise.all([
      evaluateCapitalSafety(svc),
      evaluateProcessorSafety(svc),
      evaluateCohortSafety(svc),
      evaluateRiskEngineSafety(svc),
    ])

    // Aggregate blockers
    const blockers: GovernorResult['blockers'] = []
    const addBlockers = (domain: string, d: DomainResult) => {
      for (const c of d.checks) {
        if (!c.ok) blockers.push({ domain, detail: `${c.name}: ${c.detail}` })
      }
    }
    addBlockers('capital', capital)
    addBlockers('processor', processor)
    addBlockers('cohort', cohort)
    addBlockers('risk_engine', riskEngine)

    const verdict = (capital.safe && processor.safe && cohort.safe && riskEngine.safe)
      ? 'safe' : 'not_safe'

    const result: GovernorResult = {
      verdict,
      capital, processor, cohort, riskEngine,
      blockers,
      autoAction: 'none',
      autoActionDetail: '',
      certifiedAt: new Date().toISOString(),
    }

    // Execute auto-action if enabled
    if (config.enabled !== false) {
      const autoResult = await executeAutoAction(svc, result, config)
      result.autoAction = autoResult.action
      result.autoActionDetail = autoResult.detail
    }

    // Record certification
    await svc.from('governor_certifications').insert({
      verdict,
      capital_safe: capital.safe,
      processor_safe: processor.safe,
      cohort_safe: cohort.safe,
      risk_engine_safe: riskEngine.safe,
      auto_action: result.autoAction,
      auto_action_detail: result.autoActionDetail,
      blockers,
      domains: { capital, processor, cohort, riskEngine },
      source,
    })

    // Cleanup old certifications (> 30 days)
    await svc
      .from('governor_certifications')
      .delete()
      .lt('certified_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

    return json(200, result)
  } catch (err) {
    console.error('system-governor error:', err)
    return json(500, { error: (err as Error).message })
  }
})
