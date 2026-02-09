import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature, x-webhook-timestamp',
}

interface TradePayload {
  platform_account_id: string
  platform_trade_id: string
  filled_at: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  commission?: number
  pnl?: number // Platform-provided realized PnL (Option A: treated as authoritative)
}

interface RuleSnapshot {
  cohort_id: string
  cohort_name: string
  cohort_version: number
  max_daily_loss_percent: number
  max_total_drawdown_percent: number
  profit_target_percent: number
  min_trading_days: number
  max_position_size_percent: number
  frozen_at: string
}

interface BreachResult {
  breached: boolean
  rule_type?: string
  description?: string
  actual_value?: number
  threshold?: number
}

interface ConsistencyResult {
  best_day_pnl: number
  best_day_pct_of_target: number
  max_daily_profit_cap_percent: number | null
  best_day_cap_met: boolean
  profitable_days: number
  min_profitable_days: number
  profitable_days_met: boolean
  all_consistency_met: boolean
}

interface PassEligibilityResult {
  eligible: boolean
  reason: string
  metrics: {
    profit_pct: number
    profit_target_pct: number
    trading_days: number
    min_trading_days: number
    unconfirmed_violations: number
    pending_flags: number
    consistency?: ConsistencyResult
  }
}

// Generate UUID for request correlation
function generateRequestId(): string {
  return crypto.randomUUID()
}

// Verify HMAC signature from webhook (constant-time, anti-replay)
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string
): Promise<boolean> {
  try {
    // HMAC computed over: timestamp + "." + raw_body
    const signedPayload = `${timestamp}.${payload}`
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(signedPayload)
    )
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    
    // Constant-time comparison
    if (signature.length !== expectedSignature.length) return false
    let result = 0
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
    }
    return result === 0
  } catch {
    return false
  }
}

// ========== DST-SAFE TIMEZONE HANDLING ==========
const ET_TZ = "America/New_York"

// Returns ET time parts for any Date (DST-safe via Intl API)
function getETParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d)

  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00"

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  }
}

/**
 * Trading day key with a 5pm ET rollover:
 * - If ET time is >= resetHourET => trading day is today's ET date
 * - If ET time is <  resetHourET => trading day is yesterday's ET date
 * 
 * Returns YYYY-MM-DD string representing the trading day
 */
function getTradingDayKeyET(d: Date, resetHourET = 17): string {
  const p = getETParts(d)

  // Build an ET calendar-date Date object in *UTC* just for safe arithmetic
  const etMidnightUTC = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0))

  // If before rollover, trading day belongs to previous ET date
  if (p.hour < resetHourET) {
    etMidnightUTC.setUTCDate(etMidnightUTC.getUTCDate() - 1)
  }

  // Format that shifted calendar date as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(etMidnightUTC)
}

// For violations.breach_day (DATE), use the trading day key
function getBreachDay(d: Date): string {
  return getTradingDayKeyET(d, 17)
}
// Note: daily reset + breach detection now handled atomically by ingest_trade_atomic RPC

// Check if account is eligible to be marked as 'passed' (deterministic server-side)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkPassEligibility(
  supabase: any,
  accountId: string,
  account: {
    status: string
    starting_balance: number
    current_balance: number
    trading_days_count: number
    rule_snapshot: RuleSnapshot
  },
  newBalance: number
): Promise<PassEligibilityResult> {
  const rules = account.rule_snapshot
  const startBalance = account.starting_balance
  
  // Calculate profit percentage
  const profitPct = ((newBalance - startBalance) / startBalance) * 100
  
  const baseMetrics = {
    profit_pct: profitPct,
    profit_target_pct: rules.profit_target_percent,
    trading_days: account.trading_days_count,
    min_trading_days: rules.min_trading_days,
    unconfirmed_violations: -1,
    pending_flags: -1
  }
  
  // Only consider pass if account is currently active
  if (account.status !== 'active') {
    return {
      eligible: false,
      reason: `Account status is '${account.status}', not 'active'`,
      metrics: baseMetrics
    }
  }
  
  // Check basic criteria
  if (profitPct < rules.profit_target_percent) {
    return {
      eligible: false,
      reason: `Profit target not met: ${profitPct.toFixed(2)}% < ${rules.profit_target_percent}%`,
      metrics: baseMetrics
    }
  }
  
  if (account.trading_days_count < rules.min_trading_days) {
    return {
      eligible: false,
      reason: `Trading days not met: ${account.trading_days_count} < ${rules.min_trading_days}`,
      metrics: baseMetrics
    }
  }
  
  // Check for unconfirmed violations (must be zero)
  const { count: violationCount, error: violationError } = await supabase
    .from('violations')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('confirmed_at', null)
  
  if (violationError) {
    console.error('Error checking violations:', violationError)
    return { eligible: false, reason: 'Failed to check violations', metrics: baseMetrics }
  }
  
  const unconfirmedViolations = violationCount ?? 0
  if (unconfirmedViolations > 0) {
    return {
      eligible: false,
      reason: `Has ${unconfirmedViolations} unconfirmed violation(s)`,
      metrics: { ...baseMetrics, unconfirmed_violations: unconfirmedViolations }
    }
  }
  
  // Check for pending flags (must be zero)
  const { count: flagCount, error: flagError } = await supabase
    .from('flags')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'pending')
  
  if (flagError) {
    console.error('Error checking flags:', flagError)
    return { eligible: false, reason: 'Failed to check flags', metrics: { ...baseMetrics, unconfirmed_violations: 0 } }
  }
  
  const pendingFlags = flagCount ?? 0
  if (pendingFlags > 0) {
    return {
      eligible: false,
      reason: `Has ${pendingFlags} pending flag(s)`,
      metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: pendingFlags }
    }
  }
  
  // ===== CONSISTENCY RULES CHECK (fail-closed: errors block pass) =====
  try {
    const { data: consistency, error: consistencyError } = await supabase.rpc(
      'check_consistency_rules',
      { _account_id: accountId }
    )
    
    if (consistencyError) {
      console.error('Consistency check error (fail-closed):', consistencyError)
      return {
        eligible: false,
        reason: 'Consistency check failed — pass blocked until resolved',
        metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: 0 }
      }
    }
    
    if (consistency && !consistency.all_consistency_met) {
      const reasons: string[] = []
      if (!consistency.best_day_cap_met) {
        reasons.push(`Best day (${consistency.best_day_pct_of_target}%) exceeds ${consistency.max_daily_profit_cap_percent}% cap`)
      }
      if (!consistency.profitable_days_met) {
        reasons.push(`Only ${consistency.profitable_days} profitable days (need ${consistency.min_profitable_days})`)
      }
      return {
        eligible: false,
        reason: `Consistency rules not met: ${reasons.join('; ')}`,
        metrics: {
          ...baseMetrics,
          unconfirmed_violations: 0,
          pending_flags: 0,
          consistency: consistency as ConsistencyResult
        }
      }
    }
  } catch (err) {
    console.error('Consistency check exception (fail-closed):', err)
    return {
      eligible: false,
      reason: 'Consistency check threw exception — pass blocked until resolved',
      metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: 0 }
    }
  }
  
  // All criteria met!
  return {
    eligible: true,
    reason: 'All pass criteria met',
    metrics: {
      profit_pct: profitPct,
      profit_target_pct: rules.profit_target_percent,
      trading_days: account.trading_days_count,
      min_trading_days: rules.min_trading_days,
      unconfirmed_violations: 0,
      pending_flags: 0
    }
  }
}

Deno.serve(async (req) => {
  // Generate request ID for correlation
  const requestId = generateRequestId()

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', request_id: requestId }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Create service role client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // ── PLATFORM INGEST KILL SWITCH ──
    // Check system_settings.platform_ingest_enabled before processing any trade
    const { data: ingestSetting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'platform_ingest_enabled')
      .single()

    const ingestEnabled = ingestSetting?.value === true || ingestSetting?.value === 'true'
    if (!ingestEnabled) {
      // Audit log blocked ingest for observability (signature not yet verified at this point)
      const sig = req.headers.get('x-webhook-signature') ?? 'none'
      const ts = req.headers.get('x-webhook-timestamp') ?? 'none'
      await supabase.from('cron_http_runs').insert({
        jobname: 'ingest-trade-blocked',
        http_status: 503,
        http_content: JSON.stringify({
          reason: 'platform_ingest_disabled',
          has_signature: sig !== 'none',
          has_timestamp: ts !== 'none',
          request_id: requestId,
        }),
      }).catch(() => {}) // best-effort logging

      console.log('Platform ingestion disabled — blocked request logged')
      return new Response(
        JSON.stringify({ error: 'Platform ingestion is currently disabled', request_id: requestId }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get webhook secret
    const webhookSecret = Deno.env.get('TRADE_WEBHOOK_SECRET')
    if (!webhookSecret) {
      console.error('TRADE_WEBHOOK_SECRET not configured')
      return new Response(
        JSON.stringify({ error: 'Server configuration error', request_id: requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get signature headers
    const signature = req.headers.get('x-webhook-signature')
    const timestamp = req.headers.get('x-webhook-timestamp')

    if (!signature || !timestamp) {
      return new Response(
        JSON.stringify({ error: 'Missing webhook signature', request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check timestamp freshness (5 min window) - anti-replay
    const timestampMs = parseInt(timestamp) * 1000
    const now = Date.now()
    if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
      return new Response(
        JSON.stringify({ error: 'Webhook timestamp expired', request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Read body for signature verification
    const bodyText = await req.text()

    // Verify signature (HMAC over timestamp.body)
    if (!await verifyWebhookSignature(bodyText, signature, timestamp, webhookSecret)) {
      return new Response(
        JSON.stringify({ error: 'Invalid webhook signature', request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse payload
    const payload: TradePayload = JSON.parse(bodyText)

    // Validate required fields
    if (!payload.platform_account_id || !payload.platform_trade_id || !payload.symbol || !payload.side) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields', request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Resolve internal account from platform mapping
    const { data: platformAccount, error: mappingError } = await supabase
      .from('platform_accounts')
      .select('account_id')
      .eq('platform_account_id', payload.platform_account_id)
      .single()

    if (mappingError || !platformAccount) {
      // Log unknown platform account to audit
      await supabase.from('audit_logs').insert({
        action: 'status_changed',
        request_id: requestId,
        idempotency_key: `audit.ingest:unknown_acct:${payload.platform_account_id}:${payload.platform_trade_id}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          type: 'unknown_platform_account',
          platform_account_id: payload.platform_account_id,
          platform_trade_id: payload.platform_trade_id,
          raw_payload: payload
        },
        reason: 'Trade received for unknown platform account'
      })

      return new Response(
        JSON.stringify({ 
          error: 'Unknown platform account', 
          platform_account_id: payload.platform_account_id,
          request_id: requestId
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const accountId = platformAccount.account_id

    // PnL Source-of-Truth: Platform-provided PnL is authoritative (Option A)
    const tradePnl = payload.pnl ?? 0
    const commission = payload.commission ?? 0
    const netPnl = tradePnl - commission
    const tradingDay = getTradingDayKeyET(new Date(payload.filled_at), 17)

    // ── ATOMIC RPC: lock → insert trade → metrics → breach detect → update ──
    // Eliminates non-atomic gap where trade INSERT succeeds but account UPDATE fails
    const { data: result, error: rpcError } = await supabase.rpc('ingest_trade_atomic', {
      p_account_id: accountId,
      p_platform_trade_id: payload.platform_trade_id,
      p_platform_account_id: payload.platform_account_id,
      p_symbol: payload.symbol,
      p_side: payload.side,
      p_quantity: payload.qty,
      p_entry_price: payload.price,
      p_net_pnl: netPnl,
      p_commission: commission,
      p_opened_at: payload.filled_at,
      p_raw_payload: payload,
      p_trading_day: tradingDay,
    })

    if (rpcError) {
      const errMsg = rpcError.message || ''

      if (errMsg.includes('ACCOUNT_NOT_FOUND')) {
        return new Response(
          JSON.stringify({ error: 'Account not found', request_id: requestId }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (errMsg.includes('ACCOUNT_TERMINAL')) {
        return new Response(
          JSON.stringify({ error: 'Account in terminal state', request_id: requestId }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (errMsg.includes('MISSING_RULE_SNAPSHOT')) {
        return new Response(
          JSON.stringify({ error: 'Account missing rule snapshot', request_id: requestId }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Log RPC failure
      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'status_changed' as const,
        request_id: requestId,
        idempotency_key: `audit.ingest:rpc_fail:${accountId}:${payload.platform_trade_id}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          type: 'atomic_ingestion_failed',
          error: errMsg,
          platform_trade_id: payload.platform_trade_id,
        },
        reason: 'Atomic trade ingestion RPC failed',
      }).catch(() => {})

      throw new Error(`ingest_trade_atomic failed: ${errMsg}`)
    }

    // ── Idempotency: duplicate trade ──
    if (result.duplicate) {
      return new Response(
        JSON.stringify({
          success: true,
          duplicate: true,
          platform_trade_id: payload.platform_trade_id,
          request_id: requestId,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── POST-ATOMIC: Breach event recording ──
    if (result.breach_detected) {
      const tradeTimestamp = new Date(payload.filled_at)
      const breachDay = getBreachDay(tradeTimestamp)

      // Violation with trade linkage for dispute defense
      const { error: violationError } = await supabase.from('violations').upsert(
        {
          account_id: accountId,
          trade_id: result.trade_id ?? null,
          platform_trade_id: payload.platform_trade_id ?? null,
          breach_day: breachDay,
          rule_type: result.breach_type,
          description: result.breach_description,
          actual_value: result.breach_actual,
          rule_threshold: result.breach_threshold,
          detected_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,rule_type,trade_id', ignoreDuplicates: true }
      )
      if (violationError) {
        console.error('Violation upsert error:', violationError)
      }

      // Trader-visible account event
      await supabase.from('account_events').upsert(
        {
          account_id: accountId,
          event_type: 'breach_detected' as const,
          request_id: requestId,
          idempotency_key: `acctevt.breach:${accountId}:${result.breach_type}:${result.trade_id}`,
          event_data: {
            rule: result.breach_type,
            current_value_pct: typeof result.breach_actual === 'number'
              ? result.breach_actual.toFixed(2)
              : result.breach_actual,
            limit_pct: result.breach_threshold,
            description: result.breach_description,
            threshold_crossed_at: payload.filled_at,
            trade_id: result.trade_id,
            explanation:
              `Your account triggered a ${result.breach_type === 'max_daily_loss' ? 'daily loss' : 'total drawdown'} limit. ` +
              `Current: ${typeof result.breach_actual === 'number' ? result.breach_actual.toFixed(2) : result.breach_actual}% | Limit: ${result.breach_threshold}%. ` +
              `This requires human review before any terminal decision.`,
            next_step: 'Under review — human confirmation required',
          },
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true }
      )

      // Internal audit log
      await supabase.from('audit_logs').upsert(
        {
          account_id: accountId,
          action: 'breach_detected' as const,
          request_id: requestId,
          idempotency_key: `audit.ingest:breach:${accountId}:${result.breach_type}:${result.trade_id}`,
          prev_hash: 'COMPUTED_BY_TRIGGER',
          row_hash: 'COMPUTED_BY_TRIGGER',
          details: {
            rule_type: result.breach_type,
            actual_value: result.breach_actual,
            threshold: result.breach_threshold,
            trade_id: result.trade_id,
            platform_trade_id: payload.platform_trade_id,
            net_pnl: netPnl,
            new_balance: result.new_balance,
          },
          reason: result.breach_description,
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true }
      )
    }

    // ── POST-ATOMIC: Auto-pass detection ──
    let passEligibility: PassEligibilityResult | null = null
    let accountPassed = false

    if (!result.breach_detected && result.previous_status === 'active') {
      passEligibility = await checkPassEligibility(
        supabase,
        accountId,
        {
          status: 'active',
          starting_balance: Number(result.starting_balance),
          current_balance: Number(result.new_balance),
          trading_days_count: Number(result.trading_days_count),
          rule_snapshot: result.rule_snapshot as RuleSnapshot,
        },
        Number(result.new_balance)
      )

      if (passEligibility.eligible) {
        const { error: passError } = await supabase
          .from('accounts')
          .update({
            status: 'passed',
            passed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', accountId)
          .eq('status', 'active') // Defensive: only if still active

        if (!passError) {
          accountPassed = true

          // Phase-aware messaging
          const ruleSnapshot = result.rule_snapshot as RuleSnapshot & { cohort_phase?: string }
          const cohortPhase = ruleSnapshot?.cohort_phase || 'evaluation'
          const phaseLabel =
            cohortPhase === 'evaluation'
              ? 'evaluation'
              : cohortPhase === 'verification'
                ? 'verification'
                : 'performance'
          const nextStepMsg =
            cohortPhase === 'performance'
              ? 'You can now request a payout'
              : `You'll be automatically enrolled in the next phase`

          // Trader-visible pass event
          await supabase.from('account_events').upsert(
            {
              account_id: accountId,
              event_type: 'passed' as const,
              request_id: requestId,
              idempotency_key: `acctevt.passed:${accountId}:${requestId}`,
              event_data: {
                profit_pct: passEligibility.metrics.profit_pct.toFixed(2),
                profit_target_pct: passEligibility.metrics.profit_target_pct,
                trading_days: passEligibility.metrics.trading_days,
                min_trading_days: passEligibility.metrics.min_trading_days,
                final_balance: Number(result.new_balance),
                phase: phaseLabel,
                explanation:
                  `Congratulations! You've successfully completed your ${phaseLabel}. ` +
                  `Profit: ${passEligibility.metrics.profit_pct.toFixed(2)}% (target: ${passEligibility.metrics.profit_target_pct}%). ` +
                  `Trading days: ${passEligibility.metrics.trading_days} (minimum: ${passEligibility.metrics.min_trading_days}).`,
                next_step: nextStepMsg,
              },
            },
            { onConflict: 'idempotency_key', ignoreDuplicates: true }
          )

          // Internal audit log for pass
          await supabase.from('audit_logs').upsert(
            {
              account_id: accountId,
              action: 'status_changed' as const,
              request_id: requestId,
              idempotency_key: `audit.ingest:auto_pass:${accountId}:${requestId}`,
              prev_hash: 'COMPUTED_BY_TRIGGER',
              row_hash: 'COMPUTED_BY_TRIGGER',
              details: {
                type: 'auto_pass',
                previous_status: 'active',
                new_status: 'passed',
                phase: phaseLabel,
                eligibility: passEligibility.metrics,
              },
              reason: `Account automatically passed ${phaseLabel} criteria`,
            },
            { onConflict: 'idempotency_key', ignoreDuplicates: true }
          )

          // Auto-spawn next phase account (idempotent via transition table)
          try {
            const { data: spawnResult, error: spawnError } = await supabase.rpc(
              'spawn_next_phase_account',
              { _from_account_id: accountId, _request_id: requestId }
            )
            if (spawnError) {
              console.error('spawn_next_phase_account error:', spawnError)
            } else if (spawnResult?.spawned) {
              console.log(
                `Phase transition: ${accountId} -> ${spawnResult.to_account_id}` +
                  ` (already_existed: ${spawnResult.already_existed})`
              )
            }
          } catch (spawnErr) {
            console.error('spawn_next_phase_account exception:', spawnErr)
          }
        } else {
          console.error('Failed to update account to passed:', passError)
        }
      }
    }

    // Return success with request_id for correlation
    return new Response(
      JSON.stringify({
        success: true,
        duplicate: false,
        request_id: requestId,
        trade_id: result.trade_id,
        account_id: accountId,
        new_balance: result.new_balance,
        daily_pnl: result.new_daily_pnl,
        daily_reset_occurred: result.daily_reset_occurred,
        breach_detected: result.breach_detected,
        breach_details: result.breach_detected
          ? {
              rule: result.breach_type,
              actual_pct: result.breach_actual,
              limit_pct: result.breach_threshold,
              description: result.breach_description,
            }
          : undefined,
        account_passed: accountPassed,
        pass_eligibility: passEligibility
          ? {
              eligible: passEligibility.eligible,
              reason: passEligibility.reason,
              metrics: passEligibility.metrics,
            }
          : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Trade ingestion error:', error)

    // Log processing failure (best effort, don't await)
    try {
      await supabase.from('audit_logs').insert({
        action: 'status_changed',
        request_id: requestId,
        idempotency_key: `audit.ingest:error:${requestId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          type: 'ingestion_error',
          error: error.message
        },
        reason: 'Trade ingestion failed with exception'
      })
    } catch {
      // Ignore audit log failures in error handler
    }

    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', request_id: requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
