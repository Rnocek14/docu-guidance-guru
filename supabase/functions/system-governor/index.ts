import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ── Types ──
type CheckSeverity = 'blocker' | 'warning'

interface DomainCheck {
  name: string
  ok: boolean
  severity: CheckSeverity
  detail: string
}

interface DomainResult {
  safe: boolean
  signal: 'green' | 'yellow' | 'red'
  checks: DomainCheck[]
  blockerCount: number
  warningCount: number
}

interface GovernorResult {
  verdict: 'safe' | 'not_safe' | 'error'
  capital: DomainResult
  processor: DomainResult
  cohort: DomainResult
  riskEngine: DomainResult
  blockers: { domain: string; detail: string; severity: CheckSeverity }[]
  warnings: { domain: string; detail: string }[]
  autoAction: string
  autoActionDetail: string
  certifiedAt: string
  safeStreak: number
  strictMode: boolean
  unlockThreshold: number
}

interface GovernorConfig {
  enabled?: boolean
  auto_lock?: boolean
  auto_unlock?: boolean
  strict_launch_mode?: boolean
  unlock_after_consecutive_safe?: number
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function parseSettingsValue(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

function deriveDomainResult(checks: DomainCheck[]): DomainResult {
  const blockerCount = checks.filter(c => !c.ok && c.severity === 'blocker').length
  const warningCount = checks.filter(c => !c.ok && c.severity === 'warning').length
  const safe = blockerCount === 0
  const signal: DomainResult['signal'] = blockerCount > 0 ? 'red' : warningCount > 0 ? 'yellow' : 'green'
  return { safe, signal, checks, blockerCount, warningCount }
}

// ============================================================================
// DOMAIN EVALUATORS
// ============================================================================

async function evaluateCapitalSafety(svc: any): Promise<DomainResult> {
  const checks: DomainCheck[] = []

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
    severity: 'blocker',
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
    severity: 'blocker',
    detail: hasStuck ? 'Stuck payout detected' : 'Clear',
  })

  // 4. Cash reserve configured
  checks.push({
    name: 'Cash reserve configured',
    ok: cashReserve > 0,
    severity: 'warning',
    detail: cashReserve > 0 ? `$${Math.round(cashReserve)}` : 'Not set',
  })

  return deriveDomainResult(checks)
}

async function evaluateProcessorSafety(svc: any, strict: boolean): Promise<DomainResult> {
  const checks: DomainCheck[] = []

  // 1. Dispute rate
  const disputeRes = await svc
    .from('cron_http_runs')
    .select('http_content, http_status')
    .eq('jobname', 'check-dispute-rate')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let disputeOk = false
  let disputeDetail = 'No dispute check data'
  let disputeDataMissing = true

  if (disputeRes.data?.http_content) {
    try {
      const parsed = JSON.parse(disputeRes.data.http_content)
      const rate30d = parsed?.windows?.['30d']?.rate ?? null
      if (rate30d !== null) {
        disputeDataMissing = false
        disputeOk = rate30d < 0.005
        disputeDetail = `30d rate: ${(rate30d * 100).toFixed(2)}%`
      }
    } catch { /* noop */ }
  }

  // Missing signal severity depends on strict mode
  checks.push({
    name: 'Dispute rate < 0.5%',
    ok: disputeDataMissing ? false : disputeOk,
    severity: disputeDataMissing ? (strict ? 'blocker' : 'warning') : 'blocker',
    detail: disputeDetail,
  })

  // 2. Payment system not paused inbound (by operator, not governor)
  const psRes = await svc
    .from('payment_system_state')
    .select('id, is_paused_inbound, pause_reason')
    .limit(1)
    .maybeSingle()
  const ps = psRes.data
  const pausedByOperator = ps?.is_paused_inbound && ps?.pause_reason && !ps.pause_reason.startsWith('Governor')
  checks.push({
    name: 'Not operator-paused',
    ok: !pausedByOperator,
    severity: 'warning',
    detail: pausedByOperator ? (ps.pause_reason || 'Paused by operator') : 'OK',
  })

  // 3. Stripe key present
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  const hasKey = !!stripeKey && stripeKey.length > 10
  checks.push({
    name: 'Stripe key configured',
    ok: hasKey,
    severity: 'blocker',
    detail: hasKey ? 'Present' : 'Missing',
  })

  return deriveDomainResult(checks)
}

async function evaluateCohortSafety(svc: any): Promise<DomainResult> {
  const checks: DomainCheck[] = []

  // 1. Active cohorts exist
  const cohortsRes = await svc.from('cohorts').select('id, name, is_active, tier_id').eq('is_active', true)
  const cohorts = cohortsRes.data || []
  checks.push({
    name: 'Active cohorts exist',
    ok: cohorts.length > 0,
    severity: 'blocker',
    detail: cohorts.length > 0 ? `${cohorts.length} active` : 'None',
  })

  // 2. Pass rate within range
  const breakerRes = await svc.from('econ_breaker_state').select('*').limit(1).maybeSingle()
  const breaker = breakerRes.data
  const passRate = breaker?.rolling_pass_rate ?? 0
  const passRateOk = passRate <= 0.15
  checks.push({
    name: 'Pass rate ≤ 15%',
    ok: passRateOk,
    severity: 'blocker',
    detail: `${(passRate * 100).toFixed(1)}% (${breaker?.rolling_pass_count ?? 0}/${breaker?.rolling_total_count ?? 0})`,
  })

  // 3. Breaker in normal
  const breakerNormal = breaker?.breaker_level === 'normal'
  checks.push({
    name: 'Breaker normal',
    ok: breakerNormal,
    severity: breakerNormal ? 'blocker' : 'blocker',
    detail: breaker?.breaker_level ?? 'Missing',
  })

  return deriveDomainResult(checks)
}

async function evaluateRiskEngineSafety(svc: any, strict: boolean): Promise<DomainResult> {
  const checks: DomainCheck[] = []

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
    severity: snapAge === null ? (strict ? 'blocker' : 'warning') : 'blocker',
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
    severity: 'blocker',
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
    severity: 'warning',
    detail: reserveOk ? 'Enabled with sim run' : 'Not configured',
  })

  // 4. Cron health
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
    severity: cronAge === null ? (strict ? 'blocker' : 'warning') : 'warning',
    detail: cronAge !== null ? `${Math.round(cronAge * 60)}m ago` : 'Never',
  })

  return deriveDomainResult(checks)
}

// ============================================================================
// SAFE STREAK CALCULATION
// ============================================================================

async function getSafeStreak(svc: any): Promise<number> {
  const { data } = await svc
    .from('governor_certifications')
    .select('verdict')
    .order('certified_at', { ascending: false })
    .limit(50)

  if (!data || data.length === 0) return 0
  let streak = 0
  for (const row of data) {
    if (row.verdict === 'safe') streak++
    else break
  }
  return streak
}

// ============================================================================
// AUTO-HEAL / AUTO-LOCK (using atomic RPC)
// ============================================================================

async function executeAutoAction(
  svc: any,
  verdict: string,
  blockerSummary: string,
  config: GovernorConfig,
  safeStreak: number,
): Promise<{ action: string; detail: string }> {
  const autoLock = config.auto_lock !== false
  const autoUnlock = config.auto_unlock !== false
  const unlockThreshold = config.unlock_after_consecutive_safe ?? 3

  if (verdict === 'not_safe' && autoLock) {
    // Check if already locked by governor
    const psRes = await svc
      .from('payment_system_state')
      .select('id, is_paused_inbound, is_paused_outbound, pause_reason')
      .limit(1)
      .maybeSingle()
    const ps = psRes.data

    if (ps && (!ps.is_paused_inbound || !ps.is_paused_outbound)) {
      const reason = `Governor auto-lock: ${blockerSummary.slice(0, 200)}`
      const lockRes = await svc.rpc('governor_apply_lock', {
        p_action: 'lock',
        p_reason: reason,
        p_locked_by: 'governor',
      })

      if (lockRes.error) {
        console.error('governor_apply_lock error:', lockRes.error)
        return { action: 'lock_failed', detail: lockRes.error.message }
      }

      // Notify staff
      await svc.from('staff_notifications').insert({
        category: 'governor',
        severity: 'critical',
        title: '🚨 Governor AUTO-LOCK activated',
        body: `System locked (inbound + outbound + intake): ${blockerSummary.slice(0, 300)}`,
        dedup_key: `governor-lock-${new Date().toISOString().slice(0, 13)}`,
      })

      return { action: 'locked', detail: `Auto-locked: inbound + outbound + intake paused` }
    }
    return { action: 'already_locked', detail: 'System already locked' }
  }

  if (verdict === 'safe' && autoUnlock) {
    // Only unlock if safe streak meets threshold
    if (safeStreak < unlockThreshold) {
      return {
        action: 'waiting_streak',
        detail: `Safe streak ${safeStreak}/${unlockThreshold} — waiting for ${unlockThreshold} consecutive SAFE before unlock`,
      }
    }

    // Check if locked by governor
    const psRes = await svc
      .from('payment_system_state')
      .select('id, is_paused_inbound, is_paused_outbound, pause_reason')
      .limit(1)
      .maybeSingle()
    const ps = psRes.data

    if (ps && (ps.is_paused_inbound || ps.is_paused_outbound)) {
      if (!ps.pause_reason?.startsWith('Governor')) {
        return { action: 'none', detail: 'Locked by operator — governor will not override' }
      }

      // Staged unlock: intake → outbound → inbound
      // We do all 3 stages atomically since we've verified safe streak
      for (const stage of ['unlock_intake', 'unlock_outbound', 'unlock_inbound'] as const) {
        const res = await svc.rpc('governor_apply_lock', {
          p_action: stage,
          p_reason: null,
          p_locked_by: 'governor',
        })
        if (res.error) {
          console.error(`governor_apply_lock ${stage} error:`, res.error)
          return { action: 'unlock_failed', detail: `Failed at ${stage}: ${res.error.message}` }
        }
      }

      await svc.from('staff_notifications').insert({
        category: 'governor',
        severity: 'info',
        title: '✅ Governor AUTO-UNLOCK — all clear',
        body: `${safeStreak} consecutive SAFE certifications. Staged unlock complete: intake → outbound → inbound.`,
        dedup_key: `governor-unlock-${new Date().toISOString().slice(0, 13)}`,
      })

      return { action: 'unlocked', detail: `Staged unlock complete after ${safeStreak} safe runs` }
    }
    return { action: 'none', detail: 'System already unlocked' }
  }

  return { action: 'none', detail: 'No auto-action needed' }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Auth: CRON_SECRET or admin JWT
    const authHeader = req.headers.get('Authorization')
    const cronSecret = Deno.env.get('CRON_SECRET')
    let source = 'manual'
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

    // Fetch governor config
    const configRes = await svc
      .from('system_settings')
      .select('value')
      .eq('key', 'governor_config')
      .maybeSingle()
    const config = parseSettingsValue(configRes.data?.value) as GovernorConfig
    const strict = config.strict_launch_mode !== false // default strict
    const unlockThreshold = config.unlock_after_consecutive_safe ?? 3

    // Run all 4 domain evaluations in parallel
    const [capital, processor, cohort, riskEngine] = await Promise.all([
      evaluateCapitalSafety(svc),
      evaluateProcessorSafety(svc, strict),
      evaluateCohortSafety(svc),
      evaluateRiskEngineSafety(svc, strict),
    ])

    // Aggregate blockers and warnings
    const blockers: GovernorResult['blockers'] = []
    const warnings: GovernorResult['warnings'] = []
    const addIssues = (domain: string, d: DomainResult) => {
      for (const c of d.checks) {
        if (!c.ok && c.severity === 'blocker') {
          blockers.push({ domain, detail: `${c.name}: ${c.detail}`, severity: 'blocker' })
        } else if (!c.ok && c.severity === 'warning') {
          warnings.push({ domain, detail: `${c.name}: ${c.detail}` })
        }
      }
    }
    addIssues('capital', capital)
    addIssues('processor', processor)
    addIssues('cohort', cohort)
    addIssues('risk_engine', riskEngine)

    // Verdict based ONLY on blockers
    const verdict = blockers.length === 0 ? 'safe' : 'not_safe'

    // Calculate safe streak (before this run)
    const previousStreak = await getSafeStreak(svc)
    const currentStreak = verdict === 'safe' ? previousStreak + 1 : 0

    const result: GovernorResult = {
      verdict,
      capital, processor, cohort, riskEngine,
      blockers,
      warnings,
      autoAction: 'none',
      autoActionDetail: '',
      certifiedAt: new Date().toISOString(),
      safeStreak: currentStreak,
      strictMode: strict,
      unlockThreshold,
    }

    // Execute auto-action
    if (config.enabled !== false) {
      const blockerSummary = blockers.map(b => b.detail).join('; ')
      const autoResult = await executeAutoAction(svc, verdict, blockerSummary, config, currentStreak)
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
      safe_streak: currentStreak,
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
