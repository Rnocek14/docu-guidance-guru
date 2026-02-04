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

// Check if we need a daily reset (DST-safe)
// Returns true if trading day has changed since last reset
function needsDailyReset(lastResetAt: string | null, resetHourET = 17): boolean {
  if (!lastResetAt) return true

  const now = new Date()
  const last = new Date(lastResetAt)

  // If trading day key changed since last reset, we must reset
  return getTradingDayKeyET(now, resetHourET) !== getTradingDayKeyET(last, resetHourET)
}

// For violations.breach_day (DATE), use the trading day key
function getBreachDay(d: Date): string {
  return getTradingDayKeyET(d, 17)
}

// ========== BREACH DETECTION ==========

// Check for rule breaches using frozen rule_snapshot
// PnL Source-of-Truth: Option A - We trust platform-provided PnL
function detectBreaches(
  account: { 
    starting_balance: number
    current_balance: number
    highest_balance: number
    daily_pnl: number
    daily_pnl_start_balance: number | null
    rule_snapshot: RuleSnapshot 
  },
  newPnl: number,
  newBalance: number
): BreachResult {
  const rules = account.rule_snapshot
  const startBalance = account.starting_balance
  const dailyStartBalance = account.daily_pnl_start_balance || account.current_balance
  const newDailyPnl = account.daily_pnl + newPnl

  // Check max daily loss
  // Daily loss = how much we've lost today from the day's starting balance
  if (newDailyPnl < 0) {
    const dailyLossPct = (Math.abs(newDailyPnl) / dailyStartBalance) * 100
    if (dailyLossPct >= rules.max_daily_loss_percent) {
      return {
        breached: true,
        rule_type: 'max_daily_loss',
        description: `Daily loss limit exceeded: ${dailyLossPct.toFixed(2)}% loss (limit: ${rules.max_daily_loss_percent}%)`,
        actual_value: dailyLossPct,
        threshold: rules.max_daily_loss_percent
      }
    }
  }

  // Check max total drawdown (from starting balance, not trailing)
  // Drawdown = how far we are below starting balance
  if (newBalance < startBalance) {
    const drawdownPct = ((startBalance - newBalance) / startBalance) * 100
    if (drawdownPct >= rules.max_total_drawdown_percent) {
      return {
        breached: true,
        rule_type: 'max_total_drawdown',
        description: `Total drawdown limit exceeded: ${drawdownPct.toFixed(2)}% below start (limit: ${rules.max_total_drawdown_percent}%)`,
        actual_value: drawdownPct,
        threshold: rules.max_total_drawdown_percent
      }
    }
  }

  return { breached: false }
}

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
  
  // Check basic criteria
  const profitTargetMet = profitPct >= rules.profit_target_percent
  const tradingDaysMet = account.trading_days_count >= rules.min_trading_days
  
  // Only consider pass if account is currently active
  if (account.status !== 'active') {
    return {
      eligible: false,
      reason: `Account status is '${account.status}', not 'active'`,
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: -1,
        pending_flags: -1
      }
    }
  }
  
  if (!profitTargetMet) {
    return {
      eligible: false,
      reason: `Profit target not met: ${profitPct.toFixed(2)}% < ${rules.profit_target_percent}%`,
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: -1,
        pending_flags: -1
      }
    }
  }
  
  if (!tradingDaysMet) {
    return {
      eligible: false,
      reason: `Trading days not met: ${account.trading_days_count} < ${rules.min_trading_days}`,
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: -1,
        pending_flags: -1
      }
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
    return {
      eligible: false,
      reason: 'Failed to check violations',
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: -1,
        pending_flags: -1
      }
    }
  }
  
  const unconfirmedViolations = violationCount ?? 0
  if (unconfirmedViolations > 0) {
    return {
      eligible: false,
      reason: `Has ${unconfirmedViolations} unconfirmed violation(s)`,
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: unconfirmedViolations,
        pending_flags: -1
      }
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
    return {
      eligible: false,
      reason: 'Failed to check flags',
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: 0,
        pending_flags: -1
      }
    }
  }
  
  const pendingFlags = flagCount ?? 0
  if (pendingFlags > 0) {
    return {
      eligible: false,
      reason: `Has ${pendingFlags} pending flag(s)`,
      metrics: {
        profit_pct: profitPct,
        profit_target_pct: rules.profit_target_percent,
        trading_days: account.trading_days_count,
        min_trading_days: rules.min_trading_days,
        unconfirmed_violations: 0,
        pending_flags: pendingFlags
      }
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
        action: 'account_created', // Using closest available action
        request_id: requestId,
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

    // Fetch account with rule_snapshot
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .single()

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: 'Account not found', request_id: requestId }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if account is in a terminal state
    const terminalStates = ['failed_confirmed', 'passed', 'closed']
    if (terminalStates.includes(account.status)) {
      return new Response(
        JSON.stringify({ 
          error: 'Account in terminal state', 
          status: account.status,
          request_id: requestId
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // PnL Source-of-Truth: Option A - Platform-provided PnL is authoritative
    // We store the raw payload for audit trail
    const tradePnl = payload.pnl ?? 0
    const commission = payload.commission ?? 0
    const netPnl = tradePnl - commission

    // Insert trade with raw_payload for audit (idempotent via unique constraint)
    const { data: insertedTrade, error: tradeError } = await supabase
      .from('trades')
      .insert({
        account_id: accountId,
        platform_trade_id: payload.platform_trade_id,
        platform_account_id: payload.platform_account_id,
        symbol: payload.symbol,
        side: payload.side,
        quantity: payload.qty,
        entry_price: payload.price,
        pnl: netPnl,
        commission: commission,
        opened_at: payload.filled_at,
        status: 'closed',
        raw_payload: payload // Store original for audit trail
      })
      .select()
      .single()

    // IDEMPOTENCY CHECK: On conflict/duplicate, exit BEFORE updating metrics
    if (tradeError?.code === '23505') {
      return new Response(
        JSON.stringify({ 
          success: true, 
          duplicate: true,
          platform_trade_id: payload.platform_trade_id,
          request_id: requestId
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (tradeError) {
      // Log processing failure
      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'status_changed',
        request_id: requestId,
        details: {
          type: 'trade_insert_failed',
          error: tradeError.message,
          platform_trade_id: payload.platform_trade_id
        },
        reason: 'Trade insertion failed'
      })
      throw new Error(`Failed to insert trade: ${tradeError.message}`)
    }

    // --- METRICS UPDATE (only after successful trade insert) ---

    // Check for daily reset (DST-safe)
    const resetHour = 17 // 5 PM ET (CME close)
    const shouldResetDaily = needsDailyReset(account.daily_reset_at, resetHour)

    let dailyPnl = account.daily_pnl
    let dailyPnlStartBalance = account.daily_pnl_start_balance

    if (shouldResetDaily) {
      // Reset daily counters
      dailyPnl = 0
      dailyPnlStartBalance = account.current_balance
    }

    // Calculate new metrics
    const newBalance = account.current_balance + netPnl
    const newTotalPnl = account.total_pnl + netPnl
    const newDailyPnl = dailyPnl + netPnl
    const newHighestBalance = Math.max(account.highest_balance, newBalance)

    // Detect breaches using frozen rule_snapshot
    const breachResult = detectBreaches({
      starting_balance: account.starting_balance,
      current_balance: account.current_balance,
      highest_balance: account.highest_balance,
      daily_pnl: dailyPnl,
      daily_pnl_start_balance: dailyPnlStartBalance,
      rule_snapshot: account.rule_snapshot as RuleSnapshot
    }, netPnl, newBalance)

    // Build update data
    const updateData: Record<string, unknown> = {
      current_balance: newBalance,
      total_pnl: newTotalPnl,
      daily_pnl: newDailyPnl,
      highest_balance: newHighestBalance,
      last_trade_at: payload.filled_at,
      updated_at: new Date().toISOString()
    }

    // Handle daily reset
    if (shouldResetDaily) {
      updateData.daily_pnl_start_balance = dailyPnlStartBalance
      updateData.daily_reset_at = new Date().toISOString()
    } else if (!account.daily_pnl_start_balance) {
      updateData.daily_pnl_start_balance = account.current_balance
    }

    // If breach detected, update status (Detection Only - no terminal action)
    if (breachResult.breached) {
      updateData.status = 'breached_detected'
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update(updateData)
      .eq('id', accountId)

    if (updateError) {
      // Log failure but don't throw - trade is already recorded
      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'status_changed',
        request_id: requestId,
        details: {
          type: 'account_update_failed',
          error: updateError.message,
          trade_id: insertedTrade?.id
        },
        reason: 'Account metrics update failed after trade insert'
      })
      console.error('Account update failed:', updateError)
    }

    // Handle breach detection
    if (breachResult.breached) {
      // Calculate breach_day in ET (America/New_York) for consistent deduplication
      // Uses trading day key with 5pm ET rollover for DST-safe behavior
      const detectedAt = new Date()
      const detectedAtISO = detectedAt.toISOString()
      const breachDay = getBreachDay(detectedAt)

      // Insert violation with trade linkage for dispute defense
      // Uses upsert with onConflict to handle idempotency via unique index
      const { error: violationError } = await supabase.from('violations').upsert(
        {
          account_id: accountId,
          trade_id: insertedTrade?.id ?? null,
          platform_trade_id: payload.platform_trade_id ?? null,
          breach_day: breachDay,
          rule_type: breachResult.rule_type!,
          description: breachResult.description!,
          actual_value: breachResult.actual_value,
          rule_threshold: breachResult.threshold,
          detected_at: detectedAtISO
        },
        {
          onConflict: 'account_id,rule_type,trade_id',
          ignoreDuplicates: true
        }
      )

      if (violationError) {
        console.error('Violation upsert error:', violationError)
        // Non-fatal: log but continue - the breach is still recorded in account status
      }

      // Write trader-visible account event (transparency)
      await supabase.from('account_events').insert({
        account_id: accountId,
        event_type: 'breach_detected',
        request_id: requestId,
        event_data: {
          rule: breachResult.rule_type,
          current_value_pct: breachResult.actual_value?.toFixed(2),
          limit_pct: breachResult.threshold,
          description: breachResult.description,
          threshold_crossed_at: payload.filled_at,
          trade_id: insertedTrade?.id,
          // Trader-friendly explanation
          explanation: `Your account triggered a ${breachResult.rule_type === 'max_daily_loss' ? 'daily loss' : 'total drawdown'} limit. ` +
            `Current: ${breachResult.actual_value?.toFixed(2)}% | Limit: ${breachResult.threshold}%. ` +
            `This requires human review before any terminal decision.`,
          next_step: 'Under review — human confirmation required'
        }
      })

      // Write internal audit log
      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'breach_detected',
        request_id: requestId,
        details: {
          rule_type: breachResult.rule_type,
          actual_value: breachResult.actual_value,
          threshold: breachResult.threshold,
          trade_id: insertedTrade?.id,
          platform_trade_id: payload.platform_trade_id,
          net_pnl: netPnl,
          new_balance: newBalance
        },
        reason: breachResult.description
      })
    }

    // --- AUTO-PASS DETECTION (P0-3) ---
    // Only check if no breach was detected and account is still active
    let passEligibility: PassEligibilityResult | null = null
    let accountPassed = false
    
    if (!breachResult.breached && account.status === 'active') {
      passEligibility = await checkPassEligibility(
        supabase,
        accountId,
        {
          status: account.status,
          starting_balance: account.starting_balance,
          current_balance: account.current_balance,
          trading_days_count: account.trading_days_count,
          rule_snapshot: account.rule_snapshot as RuleSnapshot
        },
        newBalance
      )
      
      if (passEligibility.eligible) {
        // Update account to 'passed' status
        const { error: passError } = await supabase
          .from('accounts')
          .update({
            status: 'passed',
            passed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', accountId)
          .eq('status', 'active') // Defensive: only if still active
        
        if (!passError) {
          accountPassed = true
          
          // Write trader-visible event (idempotent via request_id)
          await supabase.from('account_events').upsert(
            {
              account_id: accountId,
              event_type: 'passed',
              request_id: requestId,
              event_data: {
                profit_pct: passEligibility.metrics.profit_pct.toFixed(2),
                profit_target_pct: passEligibility.metrics.profit_target_pct,
                trading_days: passEligibility.metrics.trading_days,
                min_trading_days: passEligibility.metrics.min_trading_days,
                final_balance: newBalance,
                explanation: `Congratulations! You've successfully completed your evaluation. ` +
                  `Profit: ${passEligibility.metrics.profit_pct.toFixed(2)}% (target: ${passEligibility.metrics.profit_target_pct}%). ` +
                  `Trading days: ${passEligibility.metrics.trading_days} (minimum: ${passEligibility.metrics.min_trading_days}).`,
                next_step: 'You can now request a payout'
              }
            },
            {
              onConflict: 'account_id,request_id',
              ignoreDuplicates: true
            }
          )
          
          // Write internal audit log (idempotent)
          await supabase.from('audit_logs').upsert(
            {
              account_id: accountId,
              action: 'status_changed',
              request_id: requestId,
              details: {
                type: 'auto_pass',
                previous_status: 'active',
                new_status: 'passed',
                eligibility: passEligibility.metrics
              },
              reason: 'Account automatically passed evaluation criteria'
            },
            {
              onConflict: 'account_id,request_id',
              ignoreDuplicates: true
            }
          )
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
        trade_id: insertedTrade?.id,
        account_id: accountId,
        new_balance: newBalance,
        daily_pnl: newDailyPnl,
        daily_reset_occurred: shouldResetDaily,
        breach_detected: breachResult.breached,
        breach_details: breachResult.breached ? {
          rule: breachResult.rule_type,
          actual_pct: breachResult.actual_value,
          limit_pct: breachResult.threshold,
          description: breachResult.description
        } : undefined,
        account_passed: accountPassed,
        pass_eligibility: passEligibility ? {
          eligible: passEligibility.eligible,
          reason: passEligibility.reason,
          metrics: passEligibility.metrics
        } : undefined
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
