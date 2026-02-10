import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAdapter } from '../_shared/brokers/adapter.ts'
import type { BrokerWebhookContext, BrokerId } from '../_shared/brokers/types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-tv-signature, x-tv-timestamp, x-broker-id',
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

// ========== DST-SAFE TIMEZONE HANDLING ==========
const ET_TZ = "America/New_York"

function getETParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00"
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")),
  }
}

function getTradingDayKeyET(d: Date, resetHourET = 17): string {
  const p = getETParts(d)
  const etMidnightUTC = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0))
  if (p.hour < resetHourET) {
    etMidnightUTC.setUTCDate(etMidnightUTC.getUTCDate() - 1)
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(etMidnightUTC)
}

function getBreachDay(d: Date): string {
  return getTradingDayKeyET(d, 17)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkPassEligibility(
  supabase: any, accountId: string,
  account: { status: string; starting_balance: number; current_balance: number; trading_days_count: number; rule_snapshot: RuleSnapshot },
  newBalance: number
): Promise<PassEligibilityResult> {
  const rules = account.rule_snapshot
  const startBalance = account.starting_balance
  const profitPct = ((newBalance - startBalance) / startBalance) * 100

  const baseMetrics = {
    profit_pct: profitPct, profit_target_pct: rules.profit_target_percent,
    trading_days: account.trading_days_count, min_trading_days: rules.min_trading_days,
    unconfirmed_violations: -1, pending_flags: -1
  }

  if (account.status !== 'active') {
    return { eligible: false, reason: `Account status is '${account.status}', not 'active'`, metrics: baseMetrics }
  }
  if (profitPct < rules.profit_target_percent) {
    return { eligible: false, reason: `Profit target not met: ${profitPct.toFixed(2)}% < ${rules.profit_target_percent}%`, metrics: baseMetrics }
  }
  if (account.trading_days_count < rules.min_trading_days) {
    return { eligible: false, reason: `Trading days not met: ${account.trading_days_count} < ${rules.min_trading_days}`, metrics: baseMetrics }
  }

  const { count: violationCount, error: violationError } = await supabase
    .from('violations').select('*', { count: 'exact', head: true })
    .eq('account_id', accountId).is('confirmed_at', null)
  if (violationError) return { eligible: false, reason: 'Failed to check violations', metrics: baseMetrics }
  if ((violationCount ?? 0) > 0) {
    return { eligible: false, reason: `Has ${violationCount} unconfirmed violation(s)`, metrics: { ...baseMetrics, unconfirmed_violations: violationCount ?? 0 } }
  }

  const { count: flagCount, error: flagError } = await supabase
    .from('flags').select('*', { count: 'exact', head: true })
    .eq('account_id', accountId).eq('status', 'pending')
  if (flagError) return { eligible: false, reason: 'Failed to check flags', metrics: { ...baseMetrics, unconfirmed_violations: 0 } }
  if ((flagCount ?? 0) > 0) {
    return { eligible: false, reason: `Has ${flagCount} pending flag(s)`, metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: flagCount ?? 0 } }
  }

  // Consistency rules (fail-closed)
  try {
    const { data: consistency, error: consistencyError } = await supabase.rpc('check_consistency_rules', { _account_id: accountId })
    if (consistencyError) {
      return { eligible: false, reason: 'Consistency check failed — pass blocked until resolved', metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: 0 } }
    }
    if (consistency && !consistency.all_consistency_met) {
      const reasons: string[] = []
      if (!consistency.best_day_cap_met) reasons.push(`Best day exceeds cap`)
      if (!consistency.profitable_days_met) reasons.push(`Insufficient profitable days`)
      return { eligible: false, reason: `Consistency rules not met: ${reasons.join('; ')}`, metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: 0, consistency } }
    }
  } catch {
    return { eligible: false, reason: 'Consistency check exception — pass blocked', metrics: { ...baseMetrics, unconfirmed_violations: 0, pending_flags: 0 } }
  }

  return { eligible: true, reason: 'All pass criteria met', metrics: { profit_pct: profitPct, profit_target_pct: rules.profit_target_percent, trading_days: account.trading_days_count, min_trading_days: rules.min_trading_days, unconfirmed_violations: 0, pending_flags: 0 } }
}

// ── Determine broker from request headers ──
// Returns null for unknown brokers — caller must reject.
function detectBroker(req: Request): BrokerId | null {
  const explicit = req.headers.get('x-broker-id')
  if (explicit === 'tradovate') return 'tradovate'
  // Tradovate canonical headers
  if (req.headers.get('x-tv-signature') && req.headers.get('x-tv-timestamp')) return 'tradovate'
  // Unknown broker — do NOT default
  return null
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID()

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', request_id: requestId }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' } }
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // ── 1. KILL SWITCH ──
    const { data: ingestSetting } = await supabase
      .from('system_settings').select('value').eq('key', 'platform_ingest_enabled').single()

    const ingestEnabled = ingestSetting?.value === true || ingestSetting?.value === 'true'
    if (!ingestEnabled) {
      const brokerId = detectBroker(req)
      await supabase.from('audit_logs').insert({
        action: 'ingest_blocked',
        request_id: requestId,
        idempotency_key: `audit.ingest:blocked:${requestId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          reason: 'platform_ingest_disabled',
          broker: brokerId ?? 'unknown',
          has_signature: !!req.headers.get('x-tv-signature'),
        },
        reason: 'Ingest blocked: platform_ingest_enabled=false',
      }).catch(() => {})

      return new Response(
        JSON.stringify({ error: 'Platform ingestion is currently disabled', request_id: requestId, decision: 'REJECTED_DISABLED' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. READ RAW BODY (once) ──
    const rawBody = await req.text()

    // ── 3. RESOLVE BROKER + ADAPTER ──
    const brokerId = detectBroker(req)

    if (!brokerId) {
      await supabase.from('audit_logs').insert({
        action: 'ingest_rejected',
        request_id: requestId,
        idempotency_key: `audit.ingest:unknown_broker:${requestId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          reason: 'unknown_broker',
          broker_header: req.headers.get('x-broker-id') ?? null,
          has_tv_headers: !!(req.headers.get('x-tv-signature') || req.headers.get('x-tv-timestamp')),
        },
        reason: 'Ingest rejected: could not detect broker from request headers',
      }).catch(() => {})

      return new Response(
        JSON.stringify({ error: 'Unknown broker. Set x-broker-id header or use broker-specific signature headers.', request_id: requestId, decision: 'REJECTED_SCHEMA' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const adapter = await getAdapter(brokerId)

    if (!adapter) {
      return new Response(
        JSON.stringify({ error: `Broker '${brokerId}' is not supported`, request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const ctx: BrokerWebhookContext = {
      broker: brokerId,
      requestId,
      receivedAt: new Date().toISOString(),
      ip: req.headers.get('x-forwarded-for') ?? undefined,
      userAgent: req.headers.get('user-agent') ?? undefined,
    }

    // ── 4. VERIFY (signature + anti-replay) ──
    const verifyResult = await adapter.verify(req, rawBody, ctx)
    if (!verifyResult.ok) {
      await supabase.from('audit_logs').insert({
        action: 'ingest_rejected',
        request_id: requestId,
        idempotency_key: `audit.ingest:verify_fail:${requestId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          reason: verifyResult.reason,
          decision: verifyResult.decision,
          broker: brokerId,
        },
        reason: `Ingest rejected: ${verifyResult.decision}`,
      }).catch(() => {})

      return new Response(
        JSON.stringify({ error: verifyResult.reason, decision: verifyResult.decision, request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4b. PAYLOAD CAPTURE (temporary, for schema discovery) ──
    try {
      const { data: captureSetting } = await supabase
        .from('system_settings').select('value').eq('key', `${brokerId}_payload_capture_enabled`).single()

      if (captureSetting?.value === true || captureSetting?.value === 'true') {
        const encoder = new TextEncoder()
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawBody))
        const rawHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

        await supabase.from('broker_payload_samples').upsert({
          broker: brokerId,
          request_id: requestId,
          raw_body: rawBody,
          raw_hash: rawHash,
          headers_subset: {
            content_type: req.headers.get('content-type'),
            timestamp_header: req.headers.get('x-tv-timestamp'),
            user_agent: req.headers.get('user-agent'),
          },
          notes: 'auto-captured for schema discovery',
        }, { onConflict: 'raw_hash', ignoreDuplicates: true }).catch(() => {})
      }
    } catch { /* capture is best-effort, never block ingestion */ }

    // ── 5. PARSE (to CanonicalTrade) ──
    const parseResult = await adapter.parse(req, rawBody, ctx)
    if (!parseResult.ok || !parseResult.canonical) {
      return new Response(
        JSON.stringify({ error: parseResult.reason, decision: parseResult.decision, request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const trade = parseResult.canonical

    // ── 5b. VALIDATE ECONOMICS FOR FILLS ──
    // Fills MUST have explicit pnl — we don't have a position engine to compute it from price alone.
    // Without pnl, breach/pass math would silently use 0, which is catastrophically wrong.
    if (trade.eventType === 'fill' && trade.pnl === null) {
      return new Response(
        JSON.stringify({
          error: 'Fill events require explicit pnl field. Price alone is insufficient without a position engine.',
          decision: 'REJECTED_SCHEMA',
          request_id: requestId,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 5c. DEFENSIVE VALIDATION (last line of defense before RPC) ──
    const validationErrors: string[] = []
    if (trade.qty !== undefined && trade.qty !== null && (trade.qty <= 0 || !Number.isFinite(trade.qty))) {
      validationErrors.push('qty must be positive finite number')
    }
    if (trade.pnl !== null && trade.pnl !== undefined && !Number.isFinite(trade.pnl)) {
      validationErrors.push('pnl must be finite number')
    }
    if (trade.commission !== null && trade.commission !== undefined && !Number.isFinite(trade.commission)) {
      validationErrors.push('commission must be finite number')
    }
    if (trade.fees !== null && trade.fees !== undefined && !Number.isFinite(trade.fees)) {
      validationErrors.push('fees must be finite number')
    }
    if (!trade.symbolNormalized || trade.symbolNormalized.trim() === '' || trade.symbolNormalized !== trade.symbolNormalized.toUpperCase()) {
      validationErrors.push('symbolNormalized must be non-empty uppercase')
    }
    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({
          error: `Canonical validation failed: ${validationErrors.join('; ')}`,
          decision: 'REJECTED_SCHEMA',
          request_id: requestId,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 6. PLATFORM ACCOUNT MAPPING ──
    const { data: platformAccount, error: mappingError } = await supabase
      .from('platform_accounts')
      .select('account_id')
      .eq('platform_account_id', trade.externalAccountId)
      .eq('platform_name', brokerId)
      .single()

    if (mappingError || !platformAccount) {
      await supabase.from('audit_logs').insert({
        action: 'ingest_quarantined',
        request_id: requestId,
        idempotency_key: `audit.ingest:unknown_acct:${trade.externalAccountId}:${trade.externalTradeId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: {
          type: 'unknown_platform_account',
          decision: 'QUARANTINED_UNKNOWN_ACCOUNT',
          broker: brokerId,
          external_account_id: trade.externalAccountId,
          external_trade_id: trade.externalTradeId,
        },
        reason: 'Trade received for unknown platform account — quarantined'
      }).catch(() => {})

      return new Response(
        JSON.stringify({
          error: 'Unknown platform account',
          decision: 'QUARANTINED_UNKNOWN_ACCOUNT',
          external_account_id: trade.externalAccountId,
          request_id: requestId,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const accountId = platformAccount.account_id

    // ── 7. ATOMIC RPC ──
    // Use explicit pnl if provided; if missing, pass 0 but only when price is available
    // (fills without pnl AND without price were already rejected above)
    const netPnl = (trade.pnl ?? 0) - (trade.commission ?? 0) - (trade.fees ?? 0)
    const tradingDay = getTradingDayKeyET(new Date(trade.occurredAt), 17)

    const { data: result, error: rpcError } = await supabase.rpc('ingest_trade_atomic', {
      p_account_id: accountId,
      p_platform_trade_id: trade.externalTradeId,
      p_platform_account_id: trade.externalAccountId,
      p_symbol: trade.symbolNormalized,
      p_side: trade.side,
      p_quantity: trade.qty,
      p_entry_price: trade.price,  // null-safe: RPC must handle nullable price
      p_net_pnl: netPnl,
      p_commission: trade.commission ?? 0,
      p_opened_at: trade.occurredAt,
      p_raw_payload: trade.raw,
      p_trading_day: tradingDay,
    })

    if (rpcError) {
      const errMsg = rpcError.message || ''
      if (errMsg.includes('ACCOUNT_NOT_FOUND')) {
        return new Response(JSON.stringify({ error: 'Account not found', request_id: requestId }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      if (errMsg.includes('ACCOUNT_TERMINAL')) {
        return new Response(JSON.stringify({ error: 'Account in terminal state', request_id: requestId }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      if (errMsg.includes('MISSING_RULE_SNAPSHOT')) {
        return new Response(JSON.stringify({ error: 'Account missing rule snapshot', request_id: requestId }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      await supabase.from('audit_logs').insert({
        account_id: accountId,
        action: 'ingest_error',
        request_id: requestId,
        idempotency_key: `audit.ingest:rpc_fail:${accountId}:${trade.externalTradeId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: { type: 'atomic_ingestion_failed', error: errMsg, platform_trade_id: trade.externalTradeId, broker: brokerId },
        reason: 'Atomic trade ingestion RPC failed',
      }).catch(() => {})

      throw new Error(`ingest_trade_atomic failed: ${errMsg}`)
    }

    // ── 8. DUPLICATE ──
    if (result.duplicate) {
      return new Response(
        JSON.stringify({ success: true, duplicate: true, decision: 'DUPLICATE', platform_trade_id: trade.externalTradeId, request_id: requestId }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 9. POST-ATOMIC: Breach event recording ──
    if (result.breach_detected) {
      const breachDay = getBreachDay(new Date(trade.occurredAt))

      await supabase.from('violations').upsert({
        account_id: accountId, trade_id: result.trade_id ?? null,
        platform_trade_id: trade.externalTradeId, breach_day: breachDay,
        rule_type: result.breach_type, description: result.breach_description,
        actual_value: result.breach_actual, rule_threshold: result.breach_threshold,
        detected_at: new Date().toISOString(),
      }, { onConflict: 'account_id,rule_type,trade_id', ignoreDuplicates: true }).catch(e => console.error('Violation upsert error:', e))

      await supabase.from('account_events').upsert({
        account_id: accountId, event_type: 'breach_detected' as const, request_id: requestId,
        idempotency_key: `acctevt.breach:${accountId}:${result.breach_type}:${result.trade_id}`,
        event_data: {
          rule: result.breach_type,
          current_value_pct: typeof result.breach_actual === 'number' ? result.breach_actual.toFixed(2) : result.breach_actual,
          limit_pct: result.breach_threshold, description: result.breach_description,
          threshold_crossed_at: trade.occurredAt, trade_id: result.trade_id,
          explanation: `Your account triggered a ${result.breach_type === 'max_daily_loss' ? 'daily loss' : 'total drawdown'} limit. Current: ${typeof result.breach_actual === 'number' ? result.breach_actual.toFixed(2) : result.breach_actual}% | Limit: ${result.breach_threshold}%. This requires human review before any terminal decision.`,
          next_step: 'Under review — human confirmation required',
        },
      }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})

      await supabase.from('audit_logs').upsert({
        account_id: accountId, action: 'breach_detected' as const, request_id: requestId,
        idempotency_key: `audit.ingest:breach:${accountId}:${result.breach_type}:${result.trade_id}`,
        prev_hash: 'COMPUTED_BY_TRIGGER', row_hash: 'COMPUTED_BY_TRIGGER',
        details: { rule_type: result.breach_type, actual_value: result.breach_actual, threshold: result.breach_threshold, trade_id: result.trade_id, platform_trade_id: trade.externalTradeId, net_pnl: netPnl, new_balance: result.new_balance, broker: brokerId },
        reason: result.breach_description,
      }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})
    }

    // ── 10. POST-ATOMIC: Auto-pass detection ──
    let passEligibility: PassEligibilityResult | null = null
    let accountPassed = false

    if (!result.breach_detected && result.previous_status === 'active') {
      passEligibility = await checkPassEligibility(supabase, accountId, {
        status: 'active', starting_balance: Number(result.starting_balance),
        current_balance: Number(result.new_balance), trading_days_count: Number(result.trading_days_count),
        rule_snapshot: result.rule_snapshot as RuleSnapshot,
      }, Number(result.new_balance))

      if (passEligibility.eligible) {
        const { error: passError } = await supabase.from('accounts')
          .update({ status: 'passed', passed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', accountId).eq('status', 'active')

        if (!passError) {
          accountPassed = true
          const ruleSnapshot = result.rule_snapshot as RuleSnapshot & { cohort_phase?: string }
          const cohortPhase = ruleSnapshot?.cohort_phase || 'evaluation'
          const phaseLabel = cohortPhase === 'evaluation' ? 'evaluation' : cohortPhase === 'verification' ? 'verification' : 'performance'
          const nextStepMsg = cohortPhase === 'performance' ? 'You can now request a payout' : `You'll be automatically enrolled in the next phase`

          await supabase.from('account_events').upsert({
            account_id: accountId, event_type: 'passed' as const, request_id: requestId,
            idempotency_key: `acctevt.passed:${accountId}:${requestId}`,
            event_data: {
              profit_pct: passEligibility.metrics.profit_pct.toFixed(2), profit_target_pct: passEligibility.metrics.profit_target_pct,
              trading_days: passEligibility.metrics.trading_days, min_trading_days: passEligibility.metrics.min_trading_days,
              final_balance: Number(result.new_balance), phase: phaseLabel,
              explanation: `Congratulations! You've successfully completed your ${phaseLabel}. Profit: ${passEligibility.metrics.profit_pct.toFixed(2)}% (target: ${passEligibility.metrics.profit_target_pct}%). Trading days: ${passEligibility.metrics.trading_days} (minimum: ${passEligibility.metrics.min_trading_days}).`,
              next_step: nextStepMsg,
            },
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})

          await supabase.from('audit_logs').upsert({
            account_id: accountId, action: 'status_changed' as const, request_id: requestId,
            idempotency_key: `audit.ingest:auto_pass:${accountId}:${requestId}`,
            prev_hash: 'COMPUTED_BY_TRIGGER', row_hash: 'COMPUTED_BY_TRIGGER',
            details: { type: 'auto_pass', previous_status: 'active', new_status: 'passed', phase: phaseLabel, eligibility: passEligibility.metrics, broker: brokerId },
            reason: `Account automatically passed ${phaseLabel} criteria`,
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})

          try {
            const { data: spawnResult, error: spawnError } = await supabase.rpc('spawn_next_phase_account', { _from_account_id: accountId, _request_id: requestId })
            if (spawnError) console.error('spawn_next_phase_account error:', spawnError)
            else if (spawnResult?.spawned) console.log(`Phase transition: ${accountId} -> ${spawnResult.to_account_id} (already_existed: ${spawnResult.already_existed})`)
          } catch (spawnErr) {
            console.error('spawn_next_phase_account exception:', spawnErr)
          }
        }
      }
    }

    // ── 11. RESPONSE ──
    return new Response(
      JSON.stringify({
        success: true, duplicate: false, decision: 'ACCEPTED',
        request_id: requestId, trade_id: result.trade_id, account_id: accountId,
        broker: brokerId, new_balance: result.new_balance, daily_pnl: result.new_daily_pnl,
        daily_reset_occurred: result.daily_reset_occurred, breach_detected: result.breach_detected,
        breach_details: result.breach_detected ? { rule: result.breach_type, actual_pct: result.breach_actual, limit_pct: result.breach_threshold, description: result.breach_description } : undefined,
        account_passed: accountPassed,
        pass_eligibility: passEligibility ? { eligible: passEligibility.eligible, reason: passEligibility.reason, metrics: passEligibility.metrics } : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Trade ingestion error:', error)
    try {
      await supabase.from('audit_logs').insert({
        action: 'ingest_error', request_id: requestId,
        idempotency_key: `audit.ingest:error:${requestId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER', row_hash: 'COMPUTED_BY_TRIGGER',
        details: { type: 'ingestion_error', error: error.message },
        reason: 'Trade ingestion failed with exception'
      })
    } catch { /* ignore */ }

    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', request_id: requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
