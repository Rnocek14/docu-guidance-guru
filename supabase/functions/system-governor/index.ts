import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { constantTimeEqual } from '../_shared/crypto.ts'

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

interface GovernorConfig {
  enabled?: boolean
  auto_lock?: boolean
  auto_unlock?: boolean
  strict_launch_mode?: boolean
  unlock_after_consecutive_safe?: number
  min_net_buffer?: number
}

interface LockState {
  inbound_paused: boolean
  outbound_paused: boolean
  intake_paused: boolean
  intake_unknown: boolean
  lock_owner: 'governor' | 'operator' | 'none'
  pause_reason: string | null
  paused_at: string | null
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
  lockState: LockState
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

function parseBool(raw: unknown): boolean | null {
  if (raw === true) return true
  if (raw === false) return false
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'true') return true
    if (raw.toLowerCase() === 'false') return false
  }
  return null
}

function deriveDomainResult(checks: DomainCheck[]): DomainResult {
  const blockerCount = checks.filter(c => !c.ok && c.severity === 'blocker').length
  const warningCount = checks.filter(c => !c.ok && c.severity === 'warning').length
  const safe = blockerCount === 0
  const signal: DomainResult['signal'] = blockerCount > 0 ? 'red' : warningCount > 0 ? 'yellow' : 'green'
  return { safe, signal, checks, blockerCount, warningCount }
}

// ============================================================================
// LOCK STATE READER
// ============================================================================

async function readLockState(svc: any): Promise<LockState> {
  const [psRes, intakeRes, ownerRes] = await Promise.all([
    svc.from('payment_system_state')
      .select('id, is_paused_inbound, is_paused_outbound, pause_reason, paused_at')
      .limit(1).maybeSingle(),
    svc.from('system_settings').select('value').eq('key', 'global_intake_active').maybeSingle(),
    svc.from('system_settings').select('value').eq('key', 'kill_switch_owner').maybeSingle(),
  ])

  const ps = psRes.data
  const intakeActive = parseBool(intakeRes.data?.value)
  // Unknown intake = not confirmed active, so treat as "not locked" for lock-state booleans
  // (this ensures lock reconciliation will run and fix it)
  const intakePaused = intakeActive === null ? false : !intakeActive
  const intakeUnknown = intakeActive === null

  // Canonical lock owner from RPC-managed key (deterministic, not inferred from strings)
  const ownerData = parseSettingsValue(ownerRes.data?.value)
  const canonicalOwner = (ownerData?.owner as string) || 'none'

  // Determine lock owner: use canonical owner record as truth
  const anyPaused = ps?.is_paused_inbound || ps?.is_paused_outbound || intakePaused
  let lockOwner: LockState['lock_owner'] = 'none'
  if (anyPaused || canonicalOwner !== 'none') {
    if (canonicalOwner === 'governor') lockOwner = 'governor'
    else if (canonicalOwner === 'operator') lockOwner = 'operator'
    else if (anyPaused) lockOwner = ps?.pause_reason?.startsWith('Governor') ? 'governor' : 'operator'
  }

  return {
    inbound_paused: ps?.is_paused_inbound ?? false,
    outbound_paused: ps?.is_paused_outbound ?? false,
    intake_paused: intakePaused,
    intake_unknown: intakeUnknown,
    lock_owner: lockOwner,
    pause_reason: ps?.pause_reason ?? null,
    paused_at: ps?.paused_at ?? null,
  }
}

// ============================================================================
// DOMAIN EVALUATORS
// ============================================================================

async function evaluateCapitalSafety(svc: any, config: GovernorConfig): Promise<DomainResult> {
  const checks: DomainCheck[] = []
  const minBuffer = config.min_net_buffer ?? 1

  const settingsRes = await svc.rpc('get_liability_buffer_settings')
  const bufSettings = settingsRes.data as any
  const cashReserve = bufSettings?.cash_reserve ?? 0
  const assumedAvg = bufSettings?.assumed_avg_first_payout ?? 300

  const liabilityRes = await svc.rpc('get_liability_snapshot', {
    _days_forward: 7,
    _cash_reserve: cashReserve,
    _assumed_avg_first_payout: assumedAvg,
  })
  const ld = liabilityRes.data as any
  const netBuffer = ld?.net_buffer ?? null

  checks.push({
    name: `Net buffer ≥ $${minBuffer}`,
    ok: netBuffer !== null && netBuffer >= minBuffer,
    severity: 'blocker',
    detail: netBuffer !== null ? `$${Math.round(netBuffer)}` : 'Unavailable',
  })

  const stuckRes = await svc
    .from('payouts')
    .select('id')
    .in('status', ['approved', 'payment_initiated'])
    .lt('requested_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    .limit(1)
  checks.push({
    name: 'No stuck payouts > 72h',
    ok: (stuckRes.data?.length ?? 0) === 0,
    severity: 'blocker',
    detail: (stuckRes.data?.length ?? 0) > 0 ? 'Stuck payout detected' : 'Clear',
  })

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
      // check-dispute-rate stores data as snapshot_30d.dispute_rate_percent (a percentage, e.g. 0.05 = 0.05%)
      const ratePct = parsed?.snapshot_30d?.dispute_rate_percent ?? null
      const alertLevel = parsed?.effective_alert_level ?? null
      if (ratePct !== null) {
        disputeDataMissing = false
        // dispute_rate_percent is already a percentage (0.50 = 0.50%), threshold is 0.50%
        disputeOk = ratePct < 0.50 && alertLevel !== 'emergency'
        disputeDetail = `30d rate: ${Number(ratePct).toFixed(3)}%, alert: ${alertLevel ?? 'ok'}`
      }
    } catch { /* noop */ }
  }

  checks.push({
    name: 'Dispute rate < 0.5%',
    ok: disputeDataMissing ? false : disputeOk,
    severity: disputeDataMissing ? (strict ? 'blocker' : 'warning') : 'blocker',
    detail: disputeDetail,
  })

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

  const cohortsRes = await svc.from('cohorts').select('id').eq('is_active', true)
  checks.push({
    name: 'Active cohorts exist',
    ok: (cohortsRes.data?.length ?? 0) > 0,
    severity: 'blocker',
    detail: (cohortsRes.data?.length ?? 0) > 0 ? `${cohortsRes.data.length} active` : 'None',
  })

  const breakerRes = await svc.from('econ_breaker_state').select('*').limit(1).maybeSingle()
  const breaker = breakerRes.data
  const passRate = breaker?.rolling_pass_rate ?? 0
  checks.push({
    name: 'Pass rate ≤ 15%',
    ok: passRate <= 0.15,
    severity: 'blocker',
    detail: `${(passRate * 100).toFixed(1)}% (${breaker?.rolling_pass_count ?? 0}/${breaker?.rolling_total_count ?? 0})`,
  })

  checks.push({
    name: 'Breaker normal',
    ok: breaker?.breaker_level === 'normal',
    severity: 'blocker',
    detail: breaker?.breaker_level ?? 'Missing',
  })

  return deriveDomainResult(checks)
}

async function evaluateRiskEngineSafety(svc: any, strict: boolean): Promise<DomainResult> {
  const checks: DomainCheck[] = []

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

  const failRes = await svc
    .from('audit_logs')
    .select('id')
    .eq('action', 'reconciliation_failed')
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(5)
  checks.push({
    name: 'No failed audits (24h)',
    ok: (failRes.data?.length ?? 0) === 0,
    severity: 'blocker',
    detail: (failRes.data?.length ?? 0) === 0 ? 'Clear' : `${failRes.data.length} failure(s)`,
  })

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
// SAFE STREAK
// ============================================================================

async function getSafeStreak(svc: any): Promise<number> {
  const { data } = await svc
    .from('governor_certifications')
    .select('verdict')
    .order('certified_at', { ascending: false })
    .limit(50)
  if (!data?.length) return 0
  let streak = 0
  for (const row of data) {
    if (row.verdict === 'safe') streak++
    else break
  }
  return streak
}

// ============================================================================
// AUTO-HEAL / AUTO-LOCK
// ============================================================================

async function executeAutoAction(
  svc: any,
  verdict: string,
  blockerSummary: string,
  config: GovernorConfig,
  safeStreak: number,
  lockState: LockState,
): Promise<{ action: string; detail: string }> {
  const autoLock = config.auto_lock !== false
  const autoUnlock = config.auto_unlock !== false
  const unlockThreshold = config.unlock_after_consecutive_safe ?? 3

  // ── NOT SAFE: always call RPC to reconcile all 3 switches + owner ──
  if (verdict === 'not_safe' && autoLock) {
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

    const changed = lockRes.data?.changed ?? []
    const wasFull = changed.length === 0 || (changed.length === 1 && changed[0] === 'owner')

    if (!wasFull) {
      await svc.from('staff_notifications').insert({
        category: 'governor',
        severity: 'critical',
        title: '🚨 Governor AUTO-LOCK activated',
        body: `Locked switches: ${JSON.stringify(changed)}. Blockers: ${blockerSummary.slice(0, 300)}`,
        dedup_key: `governor-lock-${new Date().toISOString().slice(0, 13)}`,
      })
      return { action: 'locked', detail: `Auto-locked (changed: ${JSON.stringify(changed)})` }
    }
    return { action: 'already_locked', detail: 'All 3 switches already locked (owner reconciled)' }
  }

  // ── SAFE: staged unlock (only if governor-locked + streak met) ──
  if (verdict === 'safe' && autoUnlock) {
    if (safeStreak < unlockThreshold) {
      return {
        action: 'waiting_streak',
        detail: `Safe streak ${safeStreak}/${unlockThreshold} — need ${unlockThreshold} consecutive SAFE`,
      }
    }

    // Only auto-unlock if governor locked it
    if (lockState.lock_owner !== 'governor') {
      if (lockState.lock_owner === 'operator') {
        return { action: 'none', detail: 'Locked by operator — governor will not override' }
      }
      return { action: 'none', detail: 'System already unlocked' }
    }

    // Staged unlock: intake → outbound → inbound (all idempotent)
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
      body: `${safeStreak} consecutive SAFE. Staged unlock: intake → outbound → inbound.`,
      dedup_key: `governor-unlock-${new Date().toISOString().slice(0, 13)}`,
    })

    return { action: 'unlocked', detail: `Staged unlock after ${safeStreak} safe runs` }
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
    const authHeader = req.headers.get('Authorization') ?? ''
    const cronSecretHeader = req.headers.get('X-Cron-Secret') ?? ''

    // Resolve CRON_SECRET: prefer env var, fallback to internal_secrets table
    let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    if (!cronSecret || cronSecret.length < 16) {
      try {
        const sbLookup = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        const { data } = await sbLookup
          .from('internal_secrets')
          .select('value')
          .eq('key', 'CRON_SECRET')
          .single()
        cronSecret = data?.value ?? ''
      } catch { /* best effort */ }
    }
    let source: 'manual' | 'cron' = 'manual'
    let isAuthorized = false

    if (cronSecret && cronSecretHeader && await constantTimeEqual(cronSecretHeader, cronSecret)) {
      isAuthorized = true
      source = 'cron'
    }

    if (!isAuthorized && cronSecret && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      if (await constantTimeEqual(token, cronSecret)) {
        isAuthorized = true
        source = 'cron'
      }
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
    const rawConfig = parseSettingsValue(configRes.data?.value) as GovernorConfig
    // Build effective config with all defaults resolved (for evaluation + audit snapshot)
    const config: Required<GovernorConfig> = {
      enabled: rawConfig.enabled !== false,
      auto_lock: rawConfig.auto_lock !== false,
      auto_unlock: rawConfig.auto_unlock !== false,
      strict_launch_mode: rawConfig.strict_launch_mode !== false,
      unlock_after_consecutive_safe: rawConfig.unlock_after_consecutive_safe ?? 3,
      min_net_buffer: rawConfig.min_net_buffer ?? 1,
    }
    const strict = config.strict_launch_mode
    const unlockThreshold = config.unlock_after_consecutive_safe

    // Read current lock state + run all 4 domains in parallel
    const [lockState, capital, processor, cohort, riskEngine] = await Promise.all([
      readLockState(svc),
      evaluateCapitalSafety(svc, config),
      evaluateProcessorSafety(svc, strict),
      evaluateCohortSafety(svc),
      evaluateRiskEngineSafety(svc, strict),
    ])

    // Aggregate
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

    const verdict = blockers.length === 0 ? 'safe' : 'not_safe'
    const previousStreak = await getSafeStreak(svc)
    const currentStreak = verdict === 'safe' ? previousStreak + 1 : 0

    const result: GovernorResult = {
      verdict,
      capital, processor, cohort, riskEngine,
      blockers, warnings,
      autoAction: 'none',
      autoActionDetail: '',
      certifiedAt: new Date().toISOString(),
      safeStreak: currentStreak,
      strictMode: strict,
      unlockThreshold,
      lockState,
      effectiveConfig: config,
      source,
    }

    // Auto-action
    if (config.enabled) {
      const blockerSummary = blockers.map(b => b.detail).join('; ')
      const autoResult = await executeAutoAction(svc, verdict, blockerSummary, config, currentStreak, lockState)
      result.autoAction = autoResult.action
      result.autoActionDetail = autoResult.detail

    // Always re-read lock state after auto-action (RPC may reconcile switches even on "already_locked")
    if (autoResult.action !== 'none' && !autoResult.action.endsWith('_failed')) {
      result.lockState = await readLockState(svc)
    }
    }

    // Record certification (with warnings + config snapshot)
    await svc.from('governor_certifications').insert({
      verdict,
      capital_safe: capital.safe,
      processor_safe: processor.safe,
      cohort_safe: cohort.safe,
      risk_engine_safe: riskEngine.safe,
      auto_action: result.autoAction,
      auto_action_detail: result.autoActionDetail,
      blockers,
      warnings,
      domains: { capital, processor, cohort, riskEngine },
      source,
      safe_streak: currentStreak,
      config_snapshot: config,
    })

    // Cleanup > 30 days
    await svc
      .from('governor_certifications')
      .delete()
      .lt('certified_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

    return json(200, result)
  } catch (err) {
    console.error('system-governor error:', err)
    return json(500, { error: 'Internal server error' })
  }
})
