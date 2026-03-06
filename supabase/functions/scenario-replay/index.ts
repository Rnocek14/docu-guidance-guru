// ============================================================
// Scenario Replay Runner v1.0
// ============================================================
// Replays deterministic trade sequences through the canonical
// ingest_trade_atomic RPC and asserts expected outcomes.
//
// POST /scenario-replay
//   Auth: CRON_SECRET or admin JWT
//   Body (optional): { scenarios?: string[], prefix?: string }
//     scenarios: filter to specific scenario IDs
//     prefix: account prefix (default REPLAY-)
//
// Returns per-scenario pass/fail with full decision traces.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Types ──

interface SyntheticTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  net_pnl: number
  commission: number
  daysAgo: number
}

interface ExpectedOutcome {
  status: 'active' | 'breached_detected' | 'passed' | 'failed_confirmed'
  breachDetected: boolean
  breachType?: string
  passed: boolean
  spawnedNextPhase?: boolean
  minViolations?: number
  minEvents?: number
  balanceCheck?: (balance: number) => boolean
  balanceDescription?: string
}

interface Scenario {
  id: string
  name: string
  description: string
  cohortPhase: 'evaluation' | 'verification' | 'performance'
  trades: SyntheticTrade[]
  expected: ExpectedOutcome
  ruleOverrides?: Record<string, unknown>
}

interface TradeResult {
  tradeId: string
  success: boolean
  duplicate: boolean
  breachDetected: boolean
  breachType?: string
  newBalance?: number
  error?: string
}

interface ScenarioResult {
  scenarioId: string
  scenarioName: string
  pass: boolean
  assertions: AssertionResult[]
  tradeResults: TradeResult[]
  finalAccountStatus: string
  finalBalance: number
  violationCount: number
  eventCount: number
  durationMs: number
  error?: string
}

interface AssertionResult {
  check: string
  expected: string
  actual: string
  pass: boolean
}

// ── Cohort IDs (from live DB — same as seed-demo-data) ──
const EVAL_COHORT_ID = '30c85b00-c613-4d33-83e5-c5af8a8ea6d5'
const VERI_COHORT_ID = '1d28f164-3219-4c05-879d-a2642c15a57e'
const PERF_COHORT_ID = 'e2965581-ada0-4895-be32-4e6d984ea362'

const STARTING_BALANCE = 100000
const DEFAULT_PREFIX = 'REPLAY-'

function cohortIdForPhase(phase: string): string {
  switch (phase) {
    case 'verification': return VERI_COHORT_ID
    case 'performance': return PERF_COHORT_ID
    default: return EVAL_COHORT_ID
  }
}

// ── Date helpers ──
function makeDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(14, 0, 0, 0)
  return d.toISOString()
}

function tradingDay(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

function makeTrades(prefix: string, specs: Array<{ daysAgo: number; pnl: number; symbol?: string; side?: 'buy' | 'sell' }>): SyntheticTrade[] {
  return specs.map((s, i) => ({
    id: `${prefix}-t${i + 1}`,
    symbol: s.symbol ?? 'NQ',
    side: s.side ?? (s.pnl >= 0 ? 'buy' : 'sell'),
    qty: 1,
    price: 20000,
    net_pnl: s.pnl,
    commission: 4.50,
    daysAgo: s.daysAgo,
  }))
}

// ── Scenario Definitions ──
// Each scenario is self-contained: trades + expected outcome.
// Eval rules: 5% daily loss, 10% total DD, 10% profit target, 5 min days
// Veri rules: 5% daily loss, 10% total DD, 5% profit target, 10 min days, 5 min profitable
// Perf rules: 5% daily loss, 10% total DD, no profit target

const SCENARIOS: Scenario[] = [
  // ── S1: Daily Loss Breach ──
  {
    id: 'daily-loss-breach',
    name: 'Daily Loss Breach',
    description: 'Single day loss exceeds 5% daily loss limit → breach detected',
    cohortPhase: 'evaluation',
    trades: makeTrades('dlb', [
      { daysAgo: 10, pnl: 500 },
      { daysAgo: 9, pnl: 300 },
      { daysAgo: 8, pnl: -200 },
      // Day 4: lose > $5,000 → daily loss breach
      { daysAgo: 7, pnl: -5200 },
    ]),
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_daily_loss',
      passed: false,
      minViolations: 1,
      minEvents: 2, // account_created + breach_detected
    },
  },

  // ── S2: Total Drawdown Breach ──
  {
    id: 'total-drawdown-breach',
    name: 'Total Drawdown Breach',
    description: 'Cumulative losses exceed 10% max drawdown → breach detected',
    cohortPhase: 'evaluation',
    trades: makeTrades('tdb', [
      { daysAgo: 15, pnl: -2000 },
      { daysAgo: 14, pnl: -1500 },
      { daysAgo: 13, pnl: 500 },
      { daysAgo: 12, pnl: -2500 },
      { daysAgo: 11, pnl: -1000 },
      { daysAgo: 10, pnl: -500 },
      { daysAgo: 9, pnl: -1500 },
      { daysAgo: 8, pnl: -1600 },
    ]), // Total: -10,100 → 10.1% DD
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_total_drawdown',
      passed: false,
      minViolations: 1,
      minEvents: 2,
    },
  },

  // ── S3: Clean Profit Target Pass ──
  {
    id: 'clean-pass',
    name: 'Clean Profit Target Pass',
    description: 'Hits 10% profit target with sufficient trading days → auto-pass',
    cohortPhase: 'evaluation',
    trades: makeTrades('cp', [
      { daysAgo: 20, pnl: 2000 },
      { daysAgo: 19, pnl: 1800 },
      { daysAgo: 18, pnl: 1500 },
      { daysAgo: 17, pnl: 2200 },
      { daysAgo: 16, pnl: 1200 },
      { daysAgo: 15, pnl: 1500 },
    ]), // Total: +10,200 → 10.2% with 6 trading days (>= 5 min)
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
      minEvents: 2, // account_created + passed
    },
  },

  // ── S4: Near-Miss (just below target) ──
  {
    id: 'near-miss',
    name: 'Near Miss — Below Target',
    description: 'Profit at 9.5% (below 10% target) → stays active, no pass',
    cohortPhase: 'evaluation',
    trades: makeTrades('nm', [
      { daysAgo: 20, pnl: 1500 },
      { daysAgo: 19, pnl: 1200 },
      { daysAgo: 18, pnl: 800 },
      { daysAgo: 17, pnl: 1400 },
      { daysAgo: 16, pnl: 1100 },
      { daysAgo: 15, pnl: -500 },
      { daysAgo: 14, pnl: 2000 },
      { daysAgo: 13, pnl: 2000 },
    ]), // Total: +9,500 → 9.5%
    expected: {
      status: 'active',
      breachDetected: false,
      passed: false,
      minEvents: 1, // account_created only
    },
  },

  // ── S5: Insufficient Trading Days ──
  {
    id: 'insufficient-days',
    name: 'Insufficient Trading Days',
    description: 'Hits profit target in 3 days (needs 5) → stays active',
    cohortPhase: 'evaluation',
    trades: makeTrades('id', [
      { daysAgo: 10, pnl: 4000 },
      { daysAgo: 9, pnl: 3500 },
      { daysAgo: 8, pnl: 3000 },
    ]), // Total: +10,500 → 10.5% but only 3 days
    expected: {
      status: 'active',
      breachDetected: false,
      passed: false,
      balanceCheck: (b) => b >= 110000,
      balanceDescription: 'Balance >= $110,000 (profit above target)',
    },
  },

  // ── S6: One Big Lucky Trade ──
  {
    id: 'one-big-trade',
    name: 'One Big Lucky Trade',
    description: 'Single large win hits target — needs enough days to pass',
    cohortPhase: 'evaluation',
    trades: makeTrades('obt', [
      { daysAgo: 15, pnl: 200 },
      { daysAgo: 14, pnl: 150 },
      { daysAgo: 13, pnl: -100 },
      { daysAgo: 12, pnl: 250 },
      // Day 5: one big winner
      { daysAgo: 11, pnl: 10000 },
    ]), // Total: +10,500 → 10.5% with 5 trading days
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
    },
  },

  // ── S7: Recovery After Drawdown ──
  {
    id: 'recovery-after-drawdown',
    name: 'Recovery After Drawdown',
    description: 'Drops close to DD limit then recovers to pass',
    cohortPhase: 'evaluation',
    trades: makeTrades('rad', [
      { daysAgo: 20, pnl: -3000 },
      { daysAgo: 19, pnl: -3000 },
      { daysAgo: 18, pnl: -2000 }, // at -8% DD, close to 10% limit
      { daysAgo: 17, pnl: 3000 },
      { daysAgo: 16, pnl: 4000 },
      { daysAgo: 15, pnl: 3000 },
      { daysAgo: 14, pnl: 3000 },
      { daysAgo: 13, pnl: 5200 },
    ]), // Total: +10,200 → 10.2% with 8 days
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
    },
  },

  // ── S8: Daily Loss Exactly At Limit ──
  {
    id: 'daily-loss-at-limit',
    name: 'Daily Loss Exactly At Limit',
    description: 'Loses exactly 5% in one day — should NOT breach (limit is >5%)',
    cohortPhase: 'evaluation',
    trades: makeTrades('dlal', [
      { daysAgo: 10, pnl: 500 },
      { daysAgo: 9, pnl: 300 },
      // Day 3: lose exactly $5,000 = 5.0% of $100,000
      // Whether this breaches depends on > vs >= in the RPC
      // We test for the exact boundary behavior
      { daysAgo: 8, pnl: -5000 },
    ]),
    expected: {
      // Boundary: exact 5.0% daily loss. Most engines use > (strict), 
      // so this should NOT breach. If it does, the assertion captures it.
      status: 'active',
      breachDetected: false,
      passed: false,
    },
  },

  // ── S9: Multi-Day Drawdown Accumulation ──
  {
    id: 'multi-day-drawdown',
    name: 'Multi-Day Slow Drawdown',
    description: 'Small daily losses accumulate past 10% total DD over many days',
    cohortPhase: 'evaluation',
    trades: makeTrades('mdd', [
      { daysAgo: 20, pnl: -1200 },
      { daysAgo: 19, pnl: -1100 },
      { daysAgo: 18, pnl: -1300 },
      { daysAgo: 17, pnl: -1000 },
      { daysAgo: 16, pnl: -1100 },
      { daysAgo: 15, pnl: -1200 },
      { daysAgo: 14, pnl: -1000 },
      { daysAgo: 13, pnl: -1000 },
      { daysAgo: 12, pnl: -1200 },
    ]), // Total: -10,100 → 10.1% DD
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_total_drawdown',
      passed: false,
      minViolations: 1,
    },
  },
]

// ── Auth helper ──
async function authenticate(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization') ?? ''
  
  let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  if (!cronSecret || cronSecret.length < 16) {
    const tmpClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    )
    const { data: secretRow } = await tmpClient
      .from('internal_secrets').select('value').eq('key', 'CRON_SECRET').single()
    cronSecret = secretRow?.value ?? ''
  }

  const svcKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const bearerToken = authHeader.replace('Bearer ', '')

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true
  if (svcKey && bearerToken === svcKey) return true

  // Check admin JWT
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error } = await userClient.auth.getUser()
  if (error || !user) return false

  const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, svcKey, { auth: { persistSession: false } })
  const { data: isAdmin } = await adminClient.rpc('has_role', { _user_id: user.id, _role: 'admin' })
  return !!isAdmin
}

// ── Main ──
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (!await authenticate(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  )

  // Parse request body
  let requestedScenarios: string[] | null = null
  let prefix = DEFAULT_PREFIX
  try {
    const body = await req.json()
    if (body.scenarios && Array.isArray(body.scenarios)) {
      requestedScenarios = body.scenarios
    }
    if (body.prefix) prefix = body.prefix
  } catch { /* empty body is fine, run all scenarios */ }

  // Find a user to run scenarios against
  const { data: profile, error: profileErr } = await supabase
    .from('profiles').select('user_id, email')
    .order('created_at', { ascending: false }).limit(1).single()

  if (profileErr || !profile) {
    return new Response(JSON.stringify({ error: 'No user found in profiles' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const userId = profile.user_id
  const runId = crypto.randomUUID()
  const results: ScenarioResult[] = []

  // Filter scenarios
  const scenariosToRun = requestedScenarios
    ? SCENARIOS.filter(s => requestedScenarios!.includes(s.id))
    : SCENARIOS

  // ── Cleanup prior replay accounts ──
  const { data: oldAccounts } = await supabase
    .from('accounts').select('id').like('account_number', `${prefix}%`)

  if (oldAccounts && oldAccounts.length > 0) {
    const oldIds = oldAccounts.map(a => a.id)
    for (const oldId of oldIds) {
      await supabase.from('payout_payments').delete().in('payout_id',
        (await supabase.from('payouts').select('id').eq('account_id', oldId)).data?.map(p => p.id) ?? []
      )
      await supabase.from('payouts').delete().eq('account_id', oldId)
      await supabase.from('account_daily_stats').delete().eq('account_id', oldId)
      await supabase.from('violations').delete().eq('account_id', oldId)
      await supabase.from('account_events').delete().eq('account_id', oldId)
      await supabase.from('trades').delete().eq('account_id', oldId)
      await supabase.from('flags').delete().eq('account_id', oldId)
    }
    // Transitions
    for (const oldId of oldIds) {
      await supabase.from('account_phase_transitions').delete().eq('from_account_id', oldId)
      await supabase.from('account_phase_transitions').delete().eq('to_account_id', oldId)
      await supabase.from('platform_accounts').delete().eq('account_id', oldId)
    }
    await supabase.from('accounts').delete().like('account_number', `${prefix}%`)
    // Also clean spawned accounts
    await supabase.from('accounts').delete().like('account_number', `SPAWN-%${prefix}%`)
  }

  // ── Execute each scenario ──
  for (const scenario of scenariosToRun) {
    const start = Date.now()
    const accountNumber = `${prefix}${scenario.id}`
    const tradeResults: TradeResult[] = []
    const assertions: AssertionResult[] = []
    let scenarioError: string | undefined

    try {
      // 1. Create account
      const cohortId = cohortIdForPhase(scenario.cohortPhase)
      const { data: cohort } = await supabase.from('cohorts').select('*').eq('id', cohortId).single()

      const { data: account, error: createErr } = await supabase.from('accounts').insert({
        user_id: userId,
        cohort_id: cohortId,
        account_number: accountNumber,
        status: 'active',
        starting_balance: STARTING_BALANCE,
        current_balance: STARTING_BALANCE,
        highest_balance: STARTING_BALANCE,
        payout_cycle_start_balance: STARTING_BALANCE,
        payout_cycle_started_at: new Date().toISOString(),
        provider: 'scenario-replay',
        provider_session_id: `replay-${runId}-${scenario.id}`,
        rule_snapshot: cohort ? {
          cohort_id: cohortId,
          cohort_name: cohort.name,
          cohort_version: cohort.version,
          max_daily_loss_percent: cohort.max_daily_loss_percent,
          max_total_drawdown_percent: cohort.max_total_drawdown_percent,
          profit_target_percent: cohort.profit_target_percent,
          min_trading_days: cohort.min_trading_days,
          max_position_size_percent: cohort.max_position_size_percent,
          max_daily_profit_cap_percent: cohort.max_daily_profit_cap_percent,
          min_profitable_days: cohort.min_profitable_days,
          cohort_phase: cohort.cohort_phase,
          frozen_at: new Date().toISOString(),
        } : null,
      }).select('id').single()

      if (createErr || !account) {
        throw new Error(`Account creation failed: ${createErr?.message}`)
      }

      const accountId = account.id

      // Create platform_account mapping
      await supabase.from('platform_accounts').insert({
        account_id: accountId,
        platform_account_id: accountNumber,
        platform_name: 'scenario-replay',
      })

      // Emit account_created event
      await supabase.from('account_events').insert({
        account_id: accountId,
        event_type: 'account_created',
        idempotency_key: `replay.created:${accountId}`,
        event_data: { scenario: scenario.id, run_id: runId },
      })

      // 2. Ingest trades via atomic RPC
      let anyBreachDetected = false
      let lastBreachType: string | undefined
      let accountPassed = false

      for (const trade of scenario.trades) {
        const td = tradingDay(trade.daysAgo)
        const { data: result, error: rpcErr } = await supabase.rpc('ingest_trade_atomic', {
          p_account_id: accountId,
          p_platform_trade_id: trade.id,
          p_platform_account_id: accountNumber,
          p_symbol: trade.symbol,
          p_side: trade.side,
          p_quantity: trade.qty,
          p_entry_price: trade.price,
          p_net_pnl: trade.net_pnl,
          p_commission: trade.commission,
          p_opened_at: makeDate(trade.daysAgo),
          p_raw_payload: { scenario: scenario.id, trade_id: trade.id },
          p_trading_day: td,
        })

        if (rpcErr) {
          if (rpcErr.message?.includes('ACCOUNT_TERMINAL')) {
            tradeResults.push({ tradeId: trade.id, success: true, duplicate: false, breachDetected: false, error: 'ACCOUNT_TERMINAL (expected after breach)' })
            continue
          }
          tradeResults.push({ tradeId: trade.id, success: false, duplicate: false, breachDetected: false, error: rpcErr.message })
          continue
        }

        const breachDetected = !!result?.breach_detected
        if (breachDetected) {
          anyBreachDetected = true
          lastBreachType = result.breach_type

          // Record violation (mirror ingest-trade behavior)
          await supabase.from('violations').insert({
            account_id: accountId,
            trade_id: result.trade_id ?? null,
            platform_trade_id: trade.id,
            breach_day: td,
            rule_type: result.breach_type,
            description: result.breach_description,
            actual_value: result.breach_actual,
            rule_threshold: result.breach_threshold,
            detected_at: new Date().toISOString(),
          }).catch(() => {})

          // Record breach event
          await supabase.from('account_events').upsert({
            account_id: accountId,
            event_type: 'breach_detected',
            idempotency_key: `replay.breach:${accountId}:${result.breach_type}:${result.trade_id}`,
            event_data: {
              rule: result.breach_type,
              current_value_pct: result.breach_actual,
              limit_pct: result.breach_threshold,
              description: result.breach_description,
            },
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})
        }

        // Auto-pass check (mirror ingest-trade)
        if (!breachDetected && result?.previous_status === 'active') {
          const rules = result.rule_snapshot as Record<string, unknown> | null
          const profitTargetPct = Number(rules?.profit_target_percent ?? 0)
          const minTradingDays = Number(rules?.min_trading_days ?? 0)
          const startBal = Number(result.starting_balance ?? STARTING_BALANCE)
          const newBal = Number(result.new_balance ?? startBal)
          const tdCount = Number(result.trading_days_count ?? 0)
          const currentProfitPct = ((newBal - startBal) / startBal) * 100

          if (currentProfitPct >= profitTargetPct && tdCount >= minTradingDays) {
            // Check violations/flags
            const { count: violCount } = await supabase.from('violations')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', accountId).is('confirmed_at', null)
            const { count: flagCount } = await supabase.from('flags')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', accountId).eq('status', 'pending')

            if ((violCount ?? 0) === 0 && (flagCount ?? 0) === 0) {
              const { data: passResult, error: passErr } = await supabase.rpc('try_auto_pass', {
                _account_id: accountId,
                _request_id: `replay-${runId}-${scenario.id}`,
              })
              if (!passErr && passResult?.success && passResult?.updated) {
                accountPassed = true

                await supabase.from('account_events').upsert({
                  account_id: accountId,
                  event_type: 'passed',
                  idempotency_key: `replay.passed:${accountId}`,
                  event_data: { scenario: scenario.id, profit_pct: currentProfitPct.toFixed(2) },
                }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).catch(() => {})

                // Spawn next phase
                try {
                  await supabase.rpc('spawn_next_phase_account', { _from_account_id: accountId, _request_id: `replay-${runId}` })
                } catch { /* spawn is best-effort for replay */ }
              }
            }
          }
        }

        tradeResults.push({
          tradeId: trade.id,
          success: true,
          duplicate: !!result?.duplicate,
          breachDetected,
          breachType: result?.breach_type,
          newBalance: result?.new_balance,
        })
      }

      // 3. Fetch final state
      const { data: finalAccount } = await supabase.from('accounts')
        .select('status, current_balance').eq('id', accountId).single()

      const { count: violationCount } = await supabase.from('violations')
        .select('*', { count: 'exact', head: true }).eq('account_id', accountId)

      const { count: eventCount } = await supabase.from('account_events')
        .select('*', { count: 'exact', head: true }).eq('account_id', accountId)

      // Check for spawned account
      const { count: spawnCount } = await supabase.from('account_phase_transitions')
        .select('*', { count: 'exact', head: true }).eq('from_account_id', accountId)

      const finalStatus = finalAccount?.status ?? 'unknown'
      const finalBalance = Number(finalAccount?.current_balance ?? 0)

      // 4. Assert expected outcomes
      // Status
      assertions.push({
        check: 'account_status',
        expected: scenario.expected.status,
        actual: finalStatus,
        pass: finalStatus === scenario.expected.status,
      })

      // Breach detected
      assertions.push({
        check: 'breach_detected',
        expected: String(scenario.expected.breachDetected),
        actual: String(anyBreachDetected),
        pass: anyBreachDetected === scenario.expected.breachDetected,
      })

      // Breach type
      if (scenario.expected.breachType) {
        assertions.push({
          check: 'breach_type',
          expected: scenario.expected.breachType,
          actual: lastBreachType ?? 'none',
          pass: lastBreachType === scenario.expected.breachType,
        })
      }

      // Pass
      assertions.push({
        check: 'account_passed',
        expected: String(scenario.expected.passed),
        actual: String(accountPassed),
        pass: accountPassed === scenario.expected.passed,
      })

      // Spawned next phase
      if (scenario.expected.spawnedNextPhase !== undefined) {
        assertions.push({
          check: 'spawned_next_phase',
          expected: String(scenario.expected.spawnedNextPhase),
          actual: String((spawnCount ?? 0) > 0),
          pass: ((spawnCount ?? 0) > 0) === scenario.expected.spawnedNextPhase,
        })
      }

      // Violations
      if (scenario.expected.minViolations !== undefined) {
        assertions.push({
          check: 'min_violations',
          expected: `>= ${scenario.expected.minViolations}`,
          actual: String(violationCount ?? 0),
          pass: (violationCount ?? 0) >= scenario.expected.minViolations,
        })
      }

      // Events
      if (scenario.expected.minEvents !== undefined) {
        assertions.push({
          check: 'min_events',
          expected: `>= ${scenario.expected.minEvents}`,
          actual: String(eventCount ?? 0),
          pass: (eventCount ?? 0) >= scenario.expected.minEvents,
        })
      }

      // Balance check
      if (scenario.expected.balanceCheck) {
        assertions.push({
          check: 'balance_check',
          expected: scenario.expected.balanceDescription ?? 'custom',
          actual: `$${finalBalance.toFixed(2)}`,
          pass: scenario.expected.balanceCheck(finalBalance),
        })
      }

      const allPass = assertions.every(a => a.pass)

      results.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        pass: allPass,
        assertions,
        tradeResults,
        finalAccountStatus: finalStatus,
        finalBalance,
        violationCount: violationCount ?? 0,
        eventCount: eventCount ?? 0,
        durationMs: Date.now() - start,
      })

    } catch (e) {
      const error = e as Error
      scenarioError = error.message
      results.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        pass: false,
        assertions: [],
        tradeResults,
        finalAccountStatus: 'error',
        finalBalance: 0,
        violationCount: 0,
        eventCount: 0,
        durationMs: Date.now() - start,
        error: scenarioError,
      })
    }
  }

  // ── Summary ──
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0)

  const response = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    user: profile.email,
    prefix,
    summary: {
      total: results.length,
      passed,
      failed,
      pass_rate: results.length > 0 ? `${((passed / results.length) * 100).toFixed(1)}%` : '0%',
      duration_ms: totalDuration,
    },
    results,
    // Failed assertion details for quick scanning
    failures: results
      .filter(r => !r.pass)
      .map(r => ({
        scenario: r.scenarioId,
        error: r.error,
        failed_assertions: r.assertions.filter(a => !a.pass),
      })),
  }

  return new Response(JSON.stringify(response, null, 2), {
    status: failed > 0 ? 207 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
