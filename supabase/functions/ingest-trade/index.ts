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
  pnl?: number // Some platforms provide realized PnL directly
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

// Verify HMAC signature from webhook
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string
): Promise<boolean> {
  try {
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

// Check for rule breaches using frozen rule_snapshot
function detectBreaches(
  account: { 
    starting_balance: number
    current_balance: number
    highest_balance: number
    daily_pnl: number
    daily_pnl_start_balance: number | null
    rule_snapshot: RuleSnapshot 
  },
  newPnl: number
): BreachResult {
  const rules = account.rule_snapshot
  const newBalance = account.current_balance + newPnl
  const startBalance = account.starting_balance
  const dailyStartBalance = account.daily_pnl_start_balance || account.current_balance
  const newDailyPnl = account.daily_pnl + newPnl

  // Check max daily loss
  const dailyLossPct = ((dailyStartBalance - (dailyStartBalance + newDailyPnl)) / dailyStartBalance) * 100
  if (dailyLossPct >= rules.max_daily_loss_percent) {
    return {
      breached: true,
      rule_type: 'max_daily_loss',
      description: `Daily loss limit exceeded: ${dailyLossPct.toFixed(2)}% loss vs ${rules.max_daily_loss_percent}% limit`,
      actual_value: dailyLossPct,
      threshold: rules.max_daily_loss_percent
    }
  }

  // Check max total drawdown (from highest balance)
  const highWatermark = Math.max(account.highest_balance, newBalance)
  const drawdownPct = ((highWatermark - newBalance) / startBalance) * 100
  if (drawdownPct >= rules.max_total_drawdown_percent) {
    return {
      breached: true,
      rule_type: 'max_total_drawdown',
      description: `Total drawdown limit exceeded: ${drawdownPct.toFixed(2)}% drawdown vs ${rules.max_total_drawdown_percent}% limit`,
      actual_value: drawdownPct,
      threshold: rules.max_total_drawdown_percent
    }
  }

  return { breached: false }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Get webhook secret
    const webhookSecret = Deno.env.get('TRADE_WEBHOOK_SECRET')
    if (!webhookSecret) {
      console.error('TRADE_WEBHOOK_SECRET not configured')
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get signature headers
    const signature = req.headers.get('x-webhook-signature')
    const timestamp = req.headers.get('x-webhook-timestamp')

    if (!signature || !timestamp) {
      return new Response(
        JSON.stringify({ error: 'Missing webhook signature' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check timestamp freshness (5 min window)
    const timestampMs = parseInt(timestamp) * 1000
    const now = Date.now()
    if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
      return new Response(
        JSON.stringify({ error: 'Webhook timestamp expired' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Read body for signature verification
    const bodyText = await req.text()

    // Verify signature
    if (!await verifyWebhookSignature(bodyText, signature, timestamp, webhookSecret)) {
      return new Response(
        JSON.stringify({ error: 'Invalid webhook signature' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse payload
    const payload: TradePayload = JSON.parse(bodyText)

    // Validate required fields
    if (!payload.platform_account_id || !payload.platform_trade_id || !payload.symbol || !payload.side) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create service role client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Resolve internal account from platform mapping
    const { data: platformAccount, error: mappingError } = await supabase
      .from('platform_accounts')
      .select('account_id')
      .eq('platform_account_id', payload.platform_account_id)
      .single()

    if (mappingError || !platformAccount) {
      // For unknown accounts, log to audit (we can't flag without account_id)
      // The flags table requires account_id, so skip that

      // For unknown accounts, we can't flag without account_id
      // Log to audit instead
      await supabase.from('audit_logs').insert({
        action: 'account_created', // Using closest available action
        details: {
          type: 'unknown_platform_account',
          platform_account_id: payload.platform_account_id,
          platform_trade_id: payload.platform_trade_id
        },
        reason: 'Trade received for unknown platform account'
      })

      return new Response(
        JSON.stringify({ 
          error: 'Unknown platform account', 
          platform_account_id: payload.platform_account_id 
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
        JSON.stringify({ error: 'Account not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if account is in a terminal state
    const terminalStates = ['failed_confirmed', 'passed', 'closed']
    if (terminalStates.includes(account.status)) {
      return new Response(
        JSON.stringify({ 
          error: 'Account in terminal state', 
          status: account.status 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Calculate PnL (use provided or estimate from trade data)
    const tradePnl = payload.pnl ?? 0
    const commission = payload.commission ?? 0
    const netPnl = tradePnl - commission

    // Insert trade (idempotent via unique constraint)
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
        status: 'closed' // Assuming filled trades
      })
      .select()
      .single()

    // Check for duplicate
    if (tradeError?.code === '23505') {
      return new Response(
        JSON.stringify({ 
          success: true, 
          duplicate: true,
          platform_trade_id: payload.platform_trade_id 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (tradeError) {
      throw new Error(`Failed to insert trade: ${tradeError.message}`)
    }

    // Update account metrics
    const newBalance = account.current_balance + netPnl
    const newTotalPnl = account.total_pnl + netPnl
    const newDailyPnl = account.daily_pnl + netPnl
    const newHighestBalance = Math.max(account.highest_balance, newBalance)

    // Detect breaches using frozen rule_snapshot
    const breachResult = detectBreaches({
      starting_balance: account.starting_balance,
      current_balance: account.current_balance,
      highest_balance: account.highest_balance,
      daily_pnl: account.daily_pnl,
      daily_pnl_start_balance: account.daily_pnl_start_balance,
      rule_snapshot: account.rule_snapshot as RuleSnapshot
    }, netPnl)

    // Update account
    const updateData: Record<string, unknown> = {
      current_balance: newBalance,
      total_pnl: newTotalPnl,
      daily_pnl: newDailyPnl,
      highest_balance: newHighestBalance,
      last_trade_at: payload.filled_at,
      updated_at: new Date().toISOString()
    }

    // Set daily start balance if not set
    if (!account.daily_pnl_start_balance) {
      updateData.daily_pnl_start_balance = account.current_balance
    }

    // If breach detected, update status
    if (breachResult.breached) {
      updateData.status = 'breached_detected'
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update(updateData)
      .eq('id', accountId)

    if (updateError) {
      throw new Error(`Failed to update account: ${updateError.message}`)
    }

    // Handle breach detection
    if (breachResult.breached) {
      // Insert violation (idempotent would be nice, but for MVP we allow multiples)
      await supabase.from('violations').insert({
        account_id: accountId,
        rule_type: breachResult.rule_type!,
        description: breachResult.description!,
        actual_value: breachResult.actual_value,
        rule_threshold: breachResult.threshold,
        detected_at: new Date().toISOString()
      })

      // Write trader-visible account event
      await supabase.from('account_events').insert({
        account_id: accountId,
        event_type: 'breach_detected',
        event_data: {
          rule: breachResult.rule_type,
          current_value_pct: breachResult.actual_value?.toFixed(2),
          limit_pct: breachResult.threshold,
          description: breachResult.description,
          threshold_crossed_at: payload.filled_at,
          next_step: 'Under review — human confirmation required'
        }
      })

      // Write internal audit log
      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'breach_detected',
        details: {
          rule_type: breachResult.rule_type,
          actual_value: breachResult.actual_value,
          threshold: breachResult.threshold,
          trade_id: insertedTrade?.id,
          platform_trade_id: payload.platform_trade_id
        },
        reason: breachResult.description
      })
    }

    // Return success
    return new Response(
      JSON.stringify({
        success: true,
        duplicate: false,
        trade_id: insertedTrade?.id,
        account_id: accountId,
        new_balance: newBalance,
        breach_detected: breachResult.breached,
        breach_details: breachResult.breached ? {
          rule: breachResult.rule_type,
          description: breachResult.description
        } : undefined
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Trade ingestion error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
