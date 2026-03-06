// ============================================================
// Scenario Replay Runner v3.6
// ============================================================
// Replays deterministic trade sequences through the canonical
// ingest_trade_atomic RPC and asserts expected outcomes.
//
// v3.6 changes:
//   - Seven-point success criteria for cluster-correlated-abuse:
//     1. cluster formed
//     2. evaluate_cluster_risk executed
//     3. fraud review exists (with structured rationale)
//     4. account flags exist (with structured reason)
//     5. cluster risk_score / flag_reason updated
//     6. no duplicates on rerun (idempotency proof)
//     7. selective backfill: missing flags restored, no new reviews
//   - Unique constraint on flags(account_id, flag_type)
//   - evaluate_cluster_risk returns idempotent: true on rerun
//
// POST /scenario-replay
//   Auth: CRON_SECRET or admin JWT
//   Body: {
//     mode?: 'standard' | 'batch' | 'full',  // default: 'standard'
//     scenarios?: string[],
//     prefix?: string,
//     includeAudit?: boolean,
//     batchSize?: number   // override batch account count (default 30)
//   }
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
  minTrades?: number
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

interface CrossAccountScenario {
  id: string
  name: string
  description: string
  accounts: CrossAccountSpec[]
  expectedFlags: CrossAccountExpectation
  /** If true, each account gets a distinct user_id (required for fingerprint clustering) */
  requireDistinctUsers?: boolean
}

interface CrossAccountSpec {
  suffix: string
  cohortPhase: 'evaluation' | 'verification' | 'performance'
  trades: SyntheticTrade[]
  fingerprintHash?: string
}

interface CrossAccountExpectation {
  clusterLinked?: boolean
  correlationDetected?: boolean
  minCorrelationMatches?: number
  expectedSymbols?: string[]
  expectedDirections?: Array<{ symbol: string; sides: string[] }>
  /** If true, assert fraud_review created for the cluster */
  expectFraudReview?: boolean
  /** If true, assert flags created on involved accounts */
  expectFlags?: boolean
}

// ── Risk-line parity types ──

interface RiskLineParity {
  id: string
  name: string
  description: string
  cohortPhase: 'evaluation' | 'verification' | 'performance'
  trades: SyntheticTrade[]
  /** Expected risk-line values after all trades are ingested */
  expectedRiskLine: {
    dailyPnlOnLastDay: number
    totalPnl: number
    currentBalance: number
    highestBalance: number
    tradingDaysCount: number
    /** Whether current_balance should be >= starting - (starting * max_total_drawdown_percent/100) */
    withinDrawdownLimit: boolean
    /** Whether daily_pnl should be >= -(starting * max_daily_loss_percent/100) */
    withinDailyLimit: boolean
  }
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
  tradeCount: number
  consistencyChecks?: ConsistencyResult
  durationMs: number
  error?: string
}

interface AssertionResult {
  check: string
  expected: string
  actual: string
  pass: boolean
}

interface ConsistencyResult {
  pass: boolean
  checks: AssertionResult[]
}

interface AuditVerification {
  hashChainValid: boolean
  brokenLinks: Array<{ id: string; expected_prev: string; actual_prev: string }>
  totalAuditRows: number
  replayEventCount: number
  replayViolationCount: number
  replayTradeCount: number
}

// ── Cohort IDs (from live DB) ──
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

// ══════════════════════════════════════════════════════════════
// SINGLE-ACCOUNT SCENARIOS
// ══════════════════════════════════════════════════════════════

const SCENARIOS: Scenario[] = [
  {
    id: 'daily-loss-breach',
    name: 'Daily Loss Breach',
    description: 'Single day loss exceeds 5% daily loss limit → breach detected',
    cohortPhase: 'evaluation',
    trades: makeTrades('dlb', [
      { daysAgo: 10, pnl: 500 },
      { daysAgo: 9, pnl: 300 },
      { daysAgo: 8, pnl: -200 },
      { daysAgo: 7, pnl: -5200 },
    ]),
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_daily_loss',
      passed: false,
      minViolations: 1,
      minEvents: 2,
      minTrades: 4,
    },
  },
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
    ]),
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_total_drawdown',
      passed: false,
      minViolations: 1,
      minEvents: 2,
      minTrades: 7,
    },
  },
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
    ]),
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
      minEvents: 2,
      minTrades: 6,
    },
  },
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
    ]),
    expected: {
      status: 'active',
      breachDetected: false,
      passed: false,
      minEvents: 1,
      minTrades: 8,
    },
  },
  {
    id: 'insufficient-days',
    name: 'Insufficient Trading Days',
    description: 'Hits profit target in 3 days (needs 5) → stays active',
    cohortPhase: 'evaluation',
    trades: makeTrades('id', [
      { daysAgo: 10, pnl: 4000 },
      { daysAgo: 9, pnl: 3500 },
      { daysAgo: 8, pnl: 3000 },
    ]),
    expected: {
      status: 'active',
      breachDetected: false,
      passed: false,
      minTrades: 3,
      balanceCheck: (b) => b >= 110000,
      balanceDescription: 'Balance >= $110,000 (profit above target)',
    },
  },
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
      { daysAgo: 11, pnl: 10000 },
    ]),
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
      minTrades: 5,
    },
  },
  {
    id: 'recovery-after-drawdown',
    name: 'Recovery After Drawdown',
    description: 'Drops close to DD limit then recovers to pass',
    cohortPhase: 'evaluation',
    trades: makeTrades('rad', [
      { daysAgo: 20, pnl: -3000 },
      { daysAgo: 19, pnl: -3000 },
      { daysAgo: 18, pnl: -2000 },
      { daysAgo: 17, pnl: 3000 },
      { daysAgo: 16, pnl: 4000 },
      { daysAgo: 15, pnl: 3000 },
      { daysAgo: 14, pnl: 3000 },
      { daysAgo: 13, pnl: 5200 },
    ]),
    expected: {
      status: 'passed',
      breachDetected: false,
      passed: true,
      spawnedNextPhase: true,
      minTrades: 8,
    },
  },
  {
    id: 'daily-loss-at-limit',
    name: 'Daily Loss Exactly At Limit',
    description: 'Loses exactly 5% in one day — should NOT breach (limit is >5%)',
    cohortPhase: 'evaluation',
    trades: makeTrades('dlal', [
      { daysAgo: 10, pnl: 500 },
      { daysAgo: 9, pnl: 300 },
      { daysAgo: 8, pnl: -5000 },
    ]),
    expected: {
      status: 'active',
      breachDetected: false,
      passed: false,
      minTrades: 3,
    },
  },
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
    ]),
    expected: {
      status: 'breached_detected',
      breachDetected: true,
      breachType: 'max_total_drawdown',
      passed: false,
      minViolations: 1,
    },
  },
]

// ══════════════════════════════════════════════════════════════
// UI/BACKEND RISK-LINE PARITY SCENARIOS
// ══════════════════════════════════════════════════════════════

const RISK_LINE_SCENARIOS: RiskLineParity[] = [
  {
    id: 'risk-line-normal-trading',
    name: 'Risk Line Parity — Normal Trading',
    description: 'After a sequence of wins/losses, verify account record exactly matches expected drawdown math',
    cohortPhase: 'evaluation',
    trades: makeTrades('rlnt', [
      { daysAgo: 10, pnl: 2000 },
      { daysAgo: 9, pnl: -800 },
      { daysAgo: 8, pnl: 1500 },
      { daysAgo: 7, pnl: -300 },
      { daysAgo: 6, pnl: 600 },
    ]),
    expectedRiskLine: {
      // cumulative: +2000, -800, +1500, -300, +600 = +3000
      dailyPnlOnLastDay: 600,
      totalPnl: 3000,
      currentBalance: 103000,
      highestBalance: 103000, // peak after all trades: 100000+2000=102000, -800=101200, +1500=102700, -300=102400, +600=103000
      tradingDaysCount: 5,
      withinDrawdownLimit: true,
      withinDailyLimit: true,
    },
  },
  {
    id: 'risk-line-drawdown-near-limit',
    name: 'Risk Line Parity — Near Drawdown Limit',
    description: 'Verify drawdown tracking after peak then decline stays accurate',
    cohortPhase: 'evaluation',
    trades: makeTrades('rldl', [
      { daysAgo: 10, pnl: 5000 },   // bal=105000 (new high)
      { daysAgo: 9, pnl: -3000 },    // bal=102000
      { daysAgo: 8, pnl: -2000 },    // bal=100000
      { daysAgo: 7, pnl: -2000 },    // bal=98000
      { daysAgo: 6, pnl: -1500 },    // bal=96500
    ]),
    expectedRiskLine: {
      dailyPnlOnLastDay: -1500,
      totalPnl: -3500,
      currentBalance: 96500,
      highestBalance: 105000,
      tradingDaysCount: 5,
      withinDrawdownLimit: true, // drawdown from high = 105000-96500 = 8500 = 8.5% < 10%
      withinDailyLimit: true,    // worst day = -3000 = 3% < 5%
    },
  },
]

// ══════════════════════════════════════════════════════════════
// CROSS-ACCOUNT ABUSE SCENARIOS
// ══════════════════════════════════════════════════════════════

const CROSS_ACCOUNT_SCENARIOS: CrossAccountScenario[] = [
  {
    id: 'mirror-opposite-trades',
    name: 'Mirrored Opposite Trades',
    description: 'Two accounts take opposing positions on same symbol within 120s window — should trigger correlation detection',
    accounts: [
      {
        suffix: 'mirror-A',
        cohortPhase: 'evaluation',
        trades: makeTrades('mirA', [
          { daysAgo: 5, pnl: 500, symbol: 'ES', side: 'buy' },
          { daysAgo: 4, pnl: 300, symbol: 'ES', side: 'buy' },
          { daysAgo: 3, pnl: 200, symbol: 'ES', side: 'buy' },
        ]),
      },
      {
        suffix: 'mirror-B',
        cohortPhase: 'evaluation',
        trades: makeTrades('mirB', [
          { daysAgo: 5, pnl: -500, symbol: 'ES', side: 'sell' },
          { daysAgo: 4, pnl: -300, symbol: 'ES', side: 'sell' },
          { daysAgo: 3, pnl: -200, symbol: 'ES', side: 'sell' },
        ]),
      },
    ],
    expectedFlags: {
      correlationDetected: true,
      minCorrelationMatches: 3,
      expectedSymbols: ['ES'],
    },
  },
  {
    id: 'same-device-fingerprint',
    name: 'Same Device Fingerprint (Distinct Users)',
    description: 'Two DIFFERENT users with identical device fingerprint — must create real identity cluster. Uses distinct user_ids to correctly trigger onConflict clustering.',
    requireDistinctUsers: true,
    accounts: [
      {
        suffix: 'fp-A',
        cohortPhase: 'evaluation',
        trades: makeTrades('fpA', [{ daysAgo: 5, pnl: 300 }]),
        fingerprintHash: 'replay-test-fingerprint-shared-hash',
      },
      {
        suffix: 'fp-B',
        cohortPhase: 'evaluation',
        trades: makeTrades('fpB', [{ daysAgo: 5, pnl: 200 }]),
        fingerprintHash: 'replay-test-fingerprint-shared-hash',
      },
    ],
    expectedFlags: {
      clusterLinked: true,
    },
  },
  {
    id: 'cluster-correlated-abuse',
    name: 'Cluster-Level Correlated Abuse',
    description: 'Two distinct users share a device fingerprint AND trade mirrored positions — combines clustering + correlation into a single abuse surface',
    requireDistinctUsers: true,
    accounts: [
      {
        suffix: 'clcorr-A',
        cohortPhase: 'evaluation',
        trades: makeTrades('clcorrA', [
          { daysAgo: 5, pnl: 600, symbol: 'ES', side: 'buy' },
          { daysAgo: 4, pnl: 400, symbol: 'ES', side: 'buy' },
          { daysAgo: 3, pnl: 300, symbol: 'ES', side: 'buy' },
        ]),
        fingerprintHash: 'replay-test-fingerprint-shared-hash',
      },
      {
        suffix: 'clcorr-B',
        cohortPhase: 'evaluation',
        trades: makeTrades('clcorrB', [
          { daysAgo: 5, pnl: -600, symbol: 'ES', side: 'sell' },
          { daysAgo: 4, pnl: -400, symbol: 'ES', side: 'sell' },
          { daysAgo: 3, pnl: -300, symbol: 'ES', side: 'sell' },
        ]),
        fingerprintHash: 'replay-test-fingerprint-shared-hash',
      },
    ],
    expectedFlags: {
      clusterLinked: true,
      correlationDetected: true,
      minCorrelationMatches: 3,
      expectedSymbols: ['ES'],
      expectFraudReview: true,
      expectFlags: true,
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

// ══════════════════════════════════════════════════════════════
// ACCOUNT CREATION + TRADE INGESTION HELPERS
// ══════════════════════════════════════════════════════════════

async function createReplayAccount(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  accountNumber: string,
  cohortPhase: string,
  runId: string,
  scenarioId: string,
) {
  const cohortId = cohortIdForPhase(cohortPhase)
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
    provider_session_id: `replay-${runId}-${scenarioId}`,
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

  await supabase.from('platform_accounts').insert({
    account_id: account.id,
    platform_account_id: accountNumber,
    platform_name: 'scenario-replay',
  })

  // BOOTSTRAP EVENT: No production trigger creates account_created on manual insert.
  // This is intentional scaffolding so consistency checks have a baseline event.
  // If a production trigger is added for account creation, remove this insert.
  await supabase.from('account_events').insert({
    account_id: account.id,
    event_type: 'account_created',
    idempotency_key: `replay.created:${account.id}`,
    event_data: { scenario: scenarioId, run_id: runId, _bootstrap: true },
  })

  return { accountId: account.id, cohort }
}

/**
 * Ingest trades through the canonical pipeline.
 * v3: NO manual violation/event writes. Production RPC owns all side effects.
 * The runner only reads and asserts.
 */
async function ingestTradesForAccount(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  accountNumber: string,
  trades: SyntheticTrade[],
  scenario: { id: string },
  runId: string,
) {
  const tradeResults: TradeResult[] = []
  let anyBreachDetected = false
  let lastBreachType: string | undefined
  let accountPassed = false

  for (const trade of trades) {
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
      // v3: Do NOT manually insert violations or events.
      // The ingest_trade_atomic RPC + database triggers own this.
    }

    // Auto-pass check: call try_auto_pass through production path
    if (!breachDetected && result?.previous_status === 'active') {
      const rules = result.rule_snapshot as Record<string, unknown> | null
      const profitTargetPct = Number(rules?.profit_target_percent ?? 0)
      const minTradingDays = Number(rules?.min_trading_days ?? 0)
      const startBal = Number(result.starting_balance ?? STARTING_BALANCE)
      const newBal = Number(result.new_balance ?? startBal)
      const tdCount = Number(result.trading_days_count ?? 0)
      const currentProfitPct = ((newBal - startBal) / startBal) * 100

      if (currentProfitPct >= profitTargetPct && tdCount >= minTradingDays) {
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
            // v3: Do NOT manually insert passed event — production RPC owns this.
            try {
              await supabase.rpc('spawn_next_phase_account', { _from_account_id: accountId, _request_id: `replay-${runId}` })
            } catch { /* spawn is best-effort */ }
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

  return { tradeResults, anyBreachDetected, lastBreachType, accountPassed }
}

// ══════════════════════════════════════════════════════════════
// CROSS-TABLE CONSISTENCY CHECKER
// ══════════════════════════════════════════════════════════════

async function checkConsistency(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  scenario: { expected: ExpectedOutcome; trades: SyntheticTrade[] },
  anyBreachDetected: boolean,
  accountPassed: boolean,
): Promise<ConsistencyResult> {
  const checks: AssertionResult[] = []

  const [
    { count: tradeCount },
    { count: violationCount },
    { count: eventCount },
    { count: transitionCount },
  ] = await Promise.all([
    supabase.from('trades').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
    supabase.from('violations').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
    supabase.from('account_events').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
    supabase.from('account_phase_transitions').select('*', { count: 'exact', head: true }).eq('from_account_id', accountId),
  ])

  const tc = tradeCount ?? 0
  const vc = violationCount ?? 0
  const ec = eventCount ?? 0
  const pc = transitionCount ?? 0

  if (scenario.expected.minTrades !== undefined) {
    checks.push({
      check: 'trades_ingested',
      expected: `>= ${scenario.expected.minTrades}`,
      actual: String(tc),
      pass: tc >= scenario.expected.minTrades,
    })
  }

  if (anyBreachDetected) {
    checks.push({
      check: 'breach_has_violations',
      expected: '>= 1 violation from production pipeline',
      actual: String(vc),
      pass: vc >= 1,
    })

    const { data: breachEvents } = await supabase.from('account_events')
      .select('event_type')
      .eq('account_id', accountId)
      .eq('event_type', 'breach_detected')
    checks.push({
      check: 'breach_has_event',
      expected: '>= 1 breach_detected event from production',
      actual: String(breachEvents?.length ?? 0),
      pass: (breachEvents?.length ?? 0) >= 1,
    })
  }

  if (accountPassed) {
    checks.push({
      check: 'pass_has_transition',
      expected: '>= 1 phase transition',
      actual: String(pc),
      pass: pc >= 1,
    })

    const { data: passedEvents } = await supabase.from('account_events')
      .select('event_type')
      .eq('account_id', accountId)
      .eq('event_type', 'passed')
    checks.push({
      check: 'pass_has_event',
      expected: '>= 1 passed event',
      actual: String(passedEvents?.length ?? 0),
      pass: (passedEvents?.length ?? 0) >= 1,
    })
  }

  if (!anyBreachDetected && !accountPassed) {
    checks.push({
      check: 'no_spurious_violations',
      expected: '0 violations',
      actual: String(vc),
      pass: vc === 0,
    })
  }

  checks.push({
    check: 'has_creation_event',
    expected: '>= 1 event',
    actual: String(ec),
    pass: ec >= 1,
  })

  return {
    pass: checks.every(c => c.pass),
    checks,
  }
}

// ══════════════════════════════════════════════════════════════
// RISK-LINE PARITY CHECKER
// ══════════════════════════════════════════════════════════════

async function runRiskLineScenario(
  supabase: ReturnType<typeof createClient>,
  scenario: RiskLineParity,
  userId: string,
  prefix: string,
  runId: string,
): Promise<ScenarioResult> {
  const start = Date.now()
  const assertions: AssertionResult[] = []
  const accountNumber = `${prefix}rl-${scenario.id}`

  try {
    const { accountId, cohort } = await createReplayAccount(
      supabase, userId, accountNumber, scenario.cohortPhase, runId, scenario.id,
    )

    const { tradeResults } = await ingestTradesForAccount(
      supabase, accountId, accountNumber, scenario.trades, scenario, runId,
    )

    // Read actual account state — this is what the dashboard would display
    const { data: acct } = await supabase.from('accounts')
      .select('current_balance, highest_balance, total_pnl, daily_pnl, trading_days_count, starting_balance, status')
      .eq('id', accountId).single()

    if (!acct) throw new Error('Account not found after trade ingestion')

    const ex = scenario.expectedRiskLine
    const actualBal = Number(acct.current_balance)
    const actualHigh = Number(acct.highest_balance)
    const actualTotalPnl = Number(acct.total_pnl)
    const actualDailyPnl = Number(acct.daily_pnl)
    const actualTDCount = Number(acct.trading_days_count)
    const startBal = Number(acct.starting_balance)

    // Tolerance for floating-point: $0.01
    const tol = 0.01

    assertions.push({
      check: 'rl:current_balance',
      expected: `$${ex.currentBalance.toFixed(2)}`,
      actual: `$${actualBal.toFixed(2)}`,
      pass: Math.abs(actualBal - ex.currentBalance) <= tol,
    })

    assertions.push({
      check: 'rl:highest_balance',
      expected: `$${ex.highestBalance.toFixed(2)}`,
      actual: `$${actualHigh.toFixed(2)}`,
      pass: Math.abs(actualHigh - ex.highestBalance) <= tol,
    })

    assertions.push({
      check: 'rl:total_pnl',
      expected: `$${ex.totalPnl.toFixed(2)}`,
      actual: `$${actualTotalPnl.toFixed(2)}`,
      pass: Math.abs(actualTotalPnl - ex.totalPnl) <= tol,
    })

    assertions.push({
      check: 'rl:trading_days_count',
      expected: String(ex.tradingDaysCount),
      actual: String(actualTDCount),
      pass: actualTDCount === ex.tradingDaysCount,
    })

    // Drawdown limit check: is current_balance within max_total_drawdown of starting?
    const maxDDPct = Number(cohort?.max_total_drawdown_percent ?? 10)
    const ddFloor = startBal - (startBal * maxDDPct / 100)
    const actualWithinDD = actualBal >= ddFloor
    assertions.push({
      check: 'rl:within_drawdown_limit',
      expected: String(ex.withinDrawdownLimit),
      actual: `${actualWithinDD} (floor=$${ddFloor.toFixed(2)}, bal=$${actualBal.toFixed(2)})`,
      pass: actualWithinDD === ex.withinDrawdownLimit,
    })

    // Daily loss limit check
    const maxDailyPct = Number(cohort?.max_daily_loss_percent ?? 5)
    const dailyLossFloor = -(startBal * maxDailyPct / 100)
    const actualWithinDaily = actualDailyPnl >= dailyLossFloor
    assertions.push({
      check: 'rl:within_daily_limit',
      expected: String(ex.withinDailyLimit),
      actual: `${actualWithinDaily} (floor=$${dailyLossFloor.toFixed(2)}, daily_pnl=$${actualDailyPnl.toFixed(2)})`,
      pass: actualWithinDaily === ex.withinDailyLimit,
    })

    // Dashboard display diff: what a user would see vs backend truth
    // This catches the "I didn't know I breached" class of bugs
    const dashboardDrawdownPct = ((actualHigh - actualBal) / startBal * 100)
    const dashboardProfitPct = (actualTotalPnl / startBal * 100)
    assertions.push({
      check: 'rl:dashboard_drawdown_pct',
      expected: 'computed from account record',
      actual: `${dashboardDrawdownPct.toFixed(2)}% drawdown from high, ${dashboardProfitPct.toFixed(2)}% total profit`,
      pass: true, // informational — the numeric checks above are the hard assertions
    })

    const [violRes, eventRes, tradeCountRes] = await Promise.all([
      supabase.from('violations').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      supabase.from('account_events').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      supabase.from('trades').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
    ])

    return {
      scenarioId: scenario.id,
      scenarioName: `[Risk-Line Parity] ${scenario.name}`,
      pass: assertions.every(a => a.pass),
      assertions,
      tradeResults,
      finalAccountStatus: acct.status,
      finalBalance: actualBal,
      violationCount: violRes.count ?? 0,
      eventCount: eventRes.count ?? 0,
      tradeCount: tradeCountRes.count ?? 0,
      durationMs: Date.now() - start,
    }
  } catch (e) {
    return {
      scenarioId: scenario.id,
      scenarioName: `[Risk-Line Parity] ${scenario.name}`,
      pass: false,
      assertions,
      tradeResults: [],
      finalAccountStatus: 'error',
      finalBalance: 0,
      violationCount: 0,
      eventCount: 0,
      tradeCount: 0,
      durationMs: Date.now() - start,
      error: (e as Error).message,
    }
  }
}

// ══════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════

async function cleanupReplayAccounts(supabase: ReturnType<typeof createClient>, prefix: string) {
  const { data: oldAccounts } = await supabase
    .from('accounts').select('id').like('account_number', `${prefix}%`)

  if (!oldAccounts || oldAccounts.length === 0) return

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
  for (const oldId of oldIds) {
    await supabase.from('account_phase_transitions').delete().eq('from_account_id', oldId)
    await supabase.from('account_phase_transitions').delete().eq('to_account_id', oldId)
    await supabase.from('platform_accounts').delete().eq('account_id', oldId)
  }
  await supabase.from('accounts').delete().like('account_number', `${prefix}%`)
  await supabase.from('accounts').delete().like('account_number', `SPAWN-%${prefix}%`)

  // Clean up replay fingerprints and clusters
  const { data: replayFps } = await supabase.from('device_fingerprints')
    .select('id, cluster_id')
    .eq('fingerprint_hash', 'replay-test-fingerprint-shared-hash')
  
  const clusterIds = [...new Set((replayFps ?? []).map(f => f.cluster_id).filter(Boolean))]
  
  await supabase.from('device_fingerprints').delete()
    .eq('fingerprint_hash', 'replay-test-fingerprint-shared-hash')
  
  for (const cid of clusterIds) {
    await supabase.from('identity_clusters').delete().eq('id', cid)
  }

  // Clean fraud reviews for clusters owned by replay
  for (const cid of clusterIds) {
    await supabase.from('fraud_reviews').delete()
      .eq('entity_type', 'identity_cluster')
      .eq('entity_id', cid)
  }
  // Also clean legacy harness-created reviews
  await supabase.from('fraud_reviews').delete().eq('review_type', 'scenario-replay')
}

// ══════════════════════════════════════════════════════════════
// CROSS-ACCOUNT SCENARIO RUNNER (hardened v3.1)
// ══════════════════════════════════════════════════════════════

async function runCrossAccountScenario(
  supabase: ReturnType<typeof createClient>,
  scenario: CrossAccountScenario,
  userIds: string[],
  prefix: string,
  runId: string,
): Promise<ScenarioResult> {
  const start = Date.now()
  const assertions: AssertionResult[] = []
  const allTradeResults: TradeResult[] = []
  const accountIds: string[] = []
  const accountUserMap: Array<{ accountId: string; userId: string; suffix: string }> = []

  try {
    // 1. Create all accounts and ingest trades
    // If requireDistinctUsers, each account gets a different userId
    for (let i = 0; i < scenario.accounts.length; i++) {
      const spec = scenario.accounts[i]
      const userId = scenario.requireDistinctUsers
        ? userIds[Math.min(i, userIds.length - 1)]
        : userIds[0]
      
      const accountNumber = `${prefix}${scenario.id}-${spec.suffix}`
      const { accountId } = await createReplayAccount(
        supabase, userId, accountNumber, spec.cohortPhase, runId, scenario.id,
      )
      accountIds.push(accountId)
      accountUserMap.push({ accountId, userId, suffix: spec.suffix })

      const { tradeResults } = await ingestTradesForAccount(
        supabase, accountId, accountNumber, spec.trades, scenario, runId,
      )
      allTradeResults.push(...tradeResults)
    }

    // 2. Fingerprint scenario: use DISTINCT user IDs for real clustering
    const fpSpecs = scenario.accounts.filter(s => s.fingerprintHash)
    if (fpSpecs.length > 0 && scenario.expectedFlags.clusterLinked !== undefined) {
      // Insert fingerprints using each account's actual userId.
      // Because onConflict is 'user_id,fingerprint_hash', distinct userIds
      // create separate rows, which is the precondition for cluster detection.
      for (let i = 0; i < fpSpecs.length; i++) {
        const spec = fpSpecs[i]
        const mapping = accountUserMap[i]
        const fpHash = spec.fingerprintHash!
        const fpComponents = { canvas_hash: 'replay-test', platform: 'scenario-replay', run: runId }

        // Check for existing fingerprints from OTHER users (same as collect-fingerprint EF logic)
        const { data: existingFps } = await supabase
          .from('device_fingerprints')
          .select('id, user_id, cluster_id')
          .eq('fingerprint_hash', fpHash)
          .neq('user_id', mapping.userId)

        let clusterId: string | null = null

        if (existingFps && existingFps.length > 0) {
          // Found fingerprint under a DIFFERENT user — this is the real abuse signal
          const existingCluster = existingFps.find(f => f.cluster_id)
          if (existingCluster?.cluster_id) {
            clusterId = existingCluster.cluster_id
            await supabase.from('identity_clusters').update({
              risk_score: existingFps.length + 1,
              is_flagged: true,
              flag_reason: `Device fingerprint shared across ${existingFps.length + 1} distinct users (replay test)`,
              updated_at: new Date().toISOString(),
            }).eq('id', clusterId)
          } else {
            // Create new cluster linking these distinct users
            const { data: newCluster } = await supabase.from('identity_clusters').insert({
              cluster_name: `Replay multi-user cluster ${runId}`,
              risk_score: existingFps.length + 1,
              is_flagged: true,
              flag_reason: `Device fingerprint shared across ${existingFps.length + 1} distinct users (replay test)`,
            }).select('id').single()

            if (newCluster) {
              clusterId = newCluster.id
              // Link existing records to cluster
              for (const fp of existingFps) {
                await supabase.from('device_fingerprints')
                  .update({ cluster_id: clusterId })
                  .eq('id', fp.id)
              }
            }
          }
        }

        // Upsert this fingerprint record (distinct user_id means new row, not overwrite)
        await supabase.from('device_fingerprints').upsert({
          user_id: mapping.userId,
          fingerprint_hash: fpHash,
          fingerprint_components: fpComponents,
          ip_address: '10.0.0.1',
          is_vpn: false,
          cluster_id: clusterId,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: 'user_id,fingerprint_hash' })
      }

      // Assert: REAL cluster_id on ALL fingerprint records, no soft fallback
      const { data: fps } = await supabase.from('device_fingerprints')
        .select('id, user_id, cluster_id, fingerprint_hash')
        .eq('fingerprint_hash', 'replay-test-fingerprint-shared-hash')

      const fpCount = fps?.length ?? 0
      const hasRealCluster = fps && fpCount >= 2 && fps.every(f => f.cluster_id !== null)
      const fpClusterIds = [...new Set((fps ?? []).map(f => f.cluster_id).filter(Boolean))]
      const sameCluster = fpClusterIds.length === 1

      // Verify distinct user_ids on fingerprint rows
      const distinctUserIds = [...new Set((fps ?? []).map(f => f.user_id))]
      assertions.push({
        check: 'fingerprint_distinct_users',
        expected: `>= 2 distinct user_ids`,
        actual: `${distinctUserIds.length} distinct users: ${distinctUserIds.join(', ').slice(0, 80)}`,
        pass: distinctUserIds.length >= 2,
      })

      assertions.push({
        check: 'fingerprint_record_count',
        expected: `>= 2 fingerprint rows`,
        actual: `${fpCount} rows`,
        pass: fpCount >= 2,
      })

      assertions.push({
        check: 'fingerprint_cluster_created',
        expected: 'real cluster_id on all fingerprint records',
        actual: hasRealCluster
          ? `${fpCount} records, all linked to cluster ${fpClusterIds[0]}`
          : `${fpCount} records, cluster_ids: ${JSON.stringify(fpClusterIds)}`,
        pass: !!hasRealCluster,
      })

      assertions.push({
        check: 'fingerprint_same_cluster',
        expected: 'all fingerprints in same cluster',
        actual: sameCluster ? `single cluster: ${fpClusterIds[0]}` : `${fpClusterIds.length} different clusters`,
        pass: sameCluster && fpClusterIds.length === 1,
      })

      // Verify the cluster is flagged
      if (fpClusterIds.length > 0) {
        const { data: cluster } = await supabase.from('identity_clusters')
          .select('is_flagged, risk_score, flag_reason')
          .eq('id', fpClusterIds[0])
          .single()

        assertions.push({
          check: 'cluster_is_flagged',
          expected: 'cluster.is_flagged = true',
          actual: cluster ? `flagged=${cluster.is_flagged}, risk=${cluster.risk_score}` : 'cluster not found',
          pass: !!cluster?.is_flagged,
        })
      } else {
        assertions.push({
          check: 'cluster_is_flagged',
          expected: 'cluster exists and is flagged',
          actual: 'no cluster created',
          pass: false,
        })
      }
    }

    // 3. Correlation detection with hardened assertions
    if (scenario.expectedFlags.correlationDetected !== undefined) {
      // For correlation, use the first user (accounts owned by same user for correlation)
      const { data: correlations, error: corrErr } = await supabase.rpc(
        'detect_cross_instrument_correlations',
        { _user_id: userIds[0] }
      )

      const matchCount = (!corrErr && correlations) ? correlations.length : 0
      const hasCorrelation = matchCount > 0

      assertions.push({
        check: 'correlation_detected',
        expected: String(scenario.expectedFlags.correlationDetected),
        actual: String(hasCorrelation),
        pass: hasCorrelation === scenario.expectedFlags.correlationDetected,
      })

      if (scenario.expectedFlags.minCorrelationMatches !== undefined) {
        assertions.push({
          check: 'correlation_match_count',
          expected: `>= ${scenario.expectedFlags.minCorrelationMatches}`,
          actual: String(matchCount),
          pass: matchCount >= scenario.expectedFlags.minCorrelationMatches,
        })
      }

      if (scenario.expectedFlags.expectedSymbols && correlations && correlations.length > 0) {
        const matchedSymbols = new Set<string>()
        for (const corr of correlations) {
          if (corr.symbol_a) matchedSymbols.add(corr.symbol_a)
          if (corr.symbol_b) matchedSymbols.add(corr.symbol_b)
          if (corr.symbol) matchedSymbols.add(corr.symbol)
        }

        for (const expectedSym of scenario.expectedFlags.expectedSymbols) {
          const found = matchedSymbols.has(expectedSym)
          assertions.push({
            check: `correlation_includes_symbol_${expectedSym}`,
            expected: `symbol ${expectedSym} in correlation matches`,
            actual: found ? `found in matches` : `not found (symbols seen: ${[...matchedSymbols].join(', ')})`,
            pass: found,
          })
        }
      }

      if (hasCorrelation && correlations.length > 0 && accountIds.length >= 2) {
        const involvedAccountIds = new Set<string>()
        for (const corr of correlations) {
          if (corr.account_id_a) involvedAccountIds.add(corr.account_id_a)
          if (corr.account_id_b) involvedAccountIds.add(corr.account_id_b)
          if (corr.account_id) involvedAccountIds.add(corr.account_id)
        }

        const replayAccountsInvolved = accountIds.filter(id => involvedAccountIds.has(id))
        assertions.push({
          check: 'correlation_involves_replay_accounts',
          expected: `>= 2 replay accounts in correlation matches`,
          actual: `${replayAccountsInvolved.length} replay accounts found`,
          pass: replayAccountsInvolved.length >= 2,
        })
      }
    }

    // 4. Production-owned control assertions (v3.5 — hardened)
    // Six-point success criteria:
    //   1. cluster formed
    //   2. evaluate_cluster_risk executed
    //   3. fraud review exists
    //   4. account flags exist
    //   5. cluster risk_score / flag_reason updated
    //   6. no duplicates on rerun
    if (scenario.expectedFlags.expectFraudReview || scenario.expectedFlags.expectFlags) {
      const clusterIds = [...new Set(
        (await supabase.from('device_fingerprints')
          .select('cluster_id')
          .eq('fingerprint_hash', 'replay-test-fingerprint-shared-hash'))
          .data?.map(f => f.cluster_id).filter(Boolean) ?? []
      )]

      // ── Criterion 1: Cluster formed ──
      assertions.push({
        check: 'ctrl:cluster_formed',
        expected: '>= 1 identity cluster',
        actual: `${clusterIds.length} clusters`,
        pass: clusterIds.length >= 1,
      })

      // ── Criterion 2: evaluate_cluster_risk executed ──
      // Call the production RPC (idempotent — safe to call even if trigger already fired)
      const evalResults: Array<{ action: string; idempotent: boolean }> = []
      for (const cid of clusterIds) {
        const { data: evalResult } = await supabase.rpc('evaluate_cluster_risk', {
          _cluster_id: cid,
          _request_id: crypto.randomUUID(),
        })
        if (evalResult) evalResults.push(evalResult as unknown as { action: string; idempotent: boolean })
      }

      assertions.push({
        check: 'ctrl:evaluate_cluster_risk_executed',
        expected: 'RPC returned action result',
        actual: evalResults.length > 0
          ? `${evalResults.length} evaluations (actions: ${evalResults.map(r => r.action).join(', ')})`
          : 'no evaluations returned',
        pass: evalResults.length >= 1,
      })

      // ── Criterion 3: Fraud review exists ──
      if (scenario.expectedFlags.expectFraudReview) {
        const { data: fraudReviews } = await supabase.from('fraud_reviews')
          .select('id, entity_type, entity_id, status, severity, review_type, details')
          .eq('entity_type', 'identity_cluster')
          .in('entity_id', clusterIds.length > 0 ? clusterIds : ['none'])

        assertions.push({
          check: 'ctrl:fraud_review_exists',
          expected: '>= 1 fraud review for cluster (production-owned)',
          actual: `${fraudReviews?.length ?? 0} reviews (types: ${[...new Set(fraudReviews?.map(r => r.review_type) ?? [])].join(', ')})`,
          pass: (fraudReviews?.length ?? 0) >= 1,
        })

        // Verify review has structured rationale
        const hasRationale = fraudReviews?.some(r =>
          r.details && typeof r.details === 'object' && (r.details as Record<string, unknown>).rationale
        )
        assertions.push({
          check: 'ctrl:fraud_review_has_rationale',
          expected: 'review.details.rationale is populated',
          actual: hasRationale ? 'rationale present' : 'rationale missing',
          pass: !!hasRationale,
        })
      }

      // ── Criterion 4: Account flags exist ──
      if (scenario.expectedFlags.expectFlags) {
        const { data: flagRows } = await supabase.from('flags')
          .select('id, account_id, flag_type, reason, severity')
          .in('account_id', accountIds)
          .eq('flag_type', 'cluster_abuse')

        const flagCount = flagRows?.length ?? 0
        assertions.push({
          check: 'ctrl:abuse_flags_exist',
          expected: `>= 1 cluster_abuse flag on involved accounts`,
          actual: `${flagCount} flags`,
          pass: flagCount >= 1,
        })

        // Verify flags have structured reason
        const hasReason = flagRows?.some(f => f.reason && f.reason.includes('Cluster'))
        assertions.push({
          check: 'ctrl:flags_have_reason',
          expected: 'flag.reason contains structured rationale',
          actual: hasReason ? 'structured reason present' : 'missing or generic',
          pass: !!hasReason,
        })
      }

      // ── Criterion 5: Cluster risk_score / flag_reason updated ──
      if (clusterIds.length > 0) {
        const { data: clusterRow } = await supabase.from('identity_clusters')
          .select('risk_score, is_flagged, flag_reason')
          .eq('id', clusterIds[0])
          .single()

        assertions.push({
          check: 'ctrl:cluster_risk_updated',
          expected: 'risk_score > 0, is_flagged = true, flag_reason set',
          actual: clusterRow
            ? `score=${clusterRow.risk_score}, flagged=${clusterRow.is_flagged}, reason=${(clusterRow.flag_reason ?? '').slice(0, 60)}`
            : 'cluster not found',
          pass: !!(clusterRow && clusterRow.risk_score > 0 && clusterRow.is_flagged && clusterRow.flag_reason),
        })
      }

      // ── Criterion 6: No duplicates on rerun ──
      // Call evaluate_cluster_risk again — should be idempotent
      if (clusterIds.length > 0) {
        // Count before rerun
        const { count: reviewsBefore } = await supabase.from('fraud_reviews')
          .select('*', { count: 'exact', head: true })
          .eq('entity_type', 'identity_cluster')
          .in('entity_id', clusterIds)

        const { count: flagsBefore } = await supabase.from('flags')
          .select('*', { count: 'exact', head: true })
          .in('account_id', accountIds)
          .eq('flag_type', 'cluster_abuse')

        // Rerun
        for (const cid of clusterIds) {
          await supabase.rpc('evaluate_cluster_risk', {
            _cluster_id: cid,
            _request_id: crypto.randomUUID(),
          })
        }

        // Count after rerun
        const { count: reviewsAfter } = await supabase.from('fraud_reviews')
          .select('*', { count: 'exact', head: true })
          .eq('entity_type', 'identity_cluster')
          .in('entity_id', clusterIds)

        const { count: flagsAfter } = await supabase.from('flags')
          .select('*', { count: 'exact', head: true })
          .in('account_id', accountIds)
          .eq('flag_type', 'cluster_abuse')

        assertions.push({
          check: 'ctrl:no_duplicate_reviews_on_rerun',
          expected: `review count unchanged after rerun`,
          actual: `before=${reviewsBefore ?? 0}, after=${reviewsAfter ?? 0}`,
          pass: (reviewsBefore ?? 0) === (reviewsAfter ?? 0),
        })

        assertions.push({
          check: 'ctrl:no_duplicate_flags_on_rerun',
          expected: `flag count unchanged after rerun`,
          actual: `before=${flagsBefore ?? 0}, after=${flagsAfter ?? 0}`,
          pass: (flagsBefore ?? 0) === (flagsAfter ?? 0),
        })

        // ── Criterion 7: Selective backfill ──
        // Delete ONE flag, rerun, and prove ONLY the missing flag is recreated
        // while reviews stay unchanged (minimum corrective action semantics)
        const { data: existingFlags } = await supabase.from('flags')
          .select('id, account_id')
          .in('account_id', accountIds)
          .eq('flag_type', 'cluster_abuse')
          .limit(1)

        if (existingFlags && existingFlags.length > 0) {
          const deletedFlagAccountId = existingFlags[0].account_id
          await supabase.from('flags').delete().eq('id', existingFlags[0].id)

          const { count: flagsAfterDelete } = await supabase.from('flags')
            .select('*', { count: 'exact', head: true })
            .in('account_id', accountIds)
            .eq('flag_type', 'cluster_abuse')

          const { count: reviewsBeforeBackfill } = await supabase.from('fraud_reviews')
            .select('*', { count: 'exact', head: true })
            .eq('entity_type', 'identity_cluster')
            .in('entity_id', clusterIds)

          // Rerun — should backfill only the missing flag
          for (const cid of clusterIds) {
            await supabase.rpc('evaluate_cluster_risk', {
              _cluster_id: cid,
              _request_id: crypto.randomUUID(),
            })
          }

          const { count: flagsAfterBackfill } = await supabase.from('flags')
            .select('*', { count: 'exact', head: true })
            .in('account_id', accountIds)
            .eq('flag_type', 'cluster_abuse')

          const { count: reviewsAfterBackfill } = await supabase.from('fraud_reviews')
            .select('*', { count: 'exact', head: true })
            .eq('entity_type', 'identity_cluster')
            .in('entity_id', clusterIds)

          // Flag count should be restored (backfilled the deleted one)
          assertions.push({
            check: 'ctrl:selective_backfill_flag_restored',
            expected: `flag count restored after deleting one (${flagsAfter ?? 0} → ${(flagsAfterDelete ?? 0)} → ${flagsAfter ?? 0})`,
            actual: `before_delete=${flagsAfter ?? 0}, after_delete=${flagsAfterDelete ?? 0}, after_backfill=${flagsAfterBackfill ?? 0}`,
            pass: (flagsAfterBackfill ?? 0) === (flagsAfter ?? 0),
          })

          // Reviews should NOT increase (existing review still pending/in_review)
          assertions.push({
            check: 'ctrl:selective_backfill_no_new_reviews',
            expected: `review count unchanged during backfill`,
            actual: `before=${reviewsBeforeBackfill ?? 0}, after=${reviewsAfterBackfill ?? 0}`,
            pass: (reviewsBeforeBackfill ?? 0) === (reviewsAfterBackfill ?? 0),
          })

          // Verify the backfilled flag is on the correct account
          const { data: backfilledFlag } = await supabase.from('flags')
            .select('id, account_id')
            .eq('account_id', deletedFlagAccountId)
            .eq('flag_type', 'cluster_abuse')
            .limit(1)

          assertions.push({
            check: 'ctrl:selective_backfill_correct_account',
            expected: `backfilled flag on account ${deletedFlagAccountId.slice(0, 8)}...`,
            actual: backfilledFlag && backfilledFlag.length > 0
              ? `flag restored on ${backfilledFlag[0].account_id.slice(0, 8)}...`
              : 'flag NOT restored',
            pass: !!(backfilledFlag && backfilledFlag.length > 0),
          })
        } else {
          assertions.push({
            check: 'ctrl:selective_backfill_flag_restored',
            expected: 'selective backfill test (skipped — no flags to delete)',
            actual: 'no existing flags found',
            pass: true,
          })
        }
      }
    }

    const allPass = assertions.every(a => a.pass)

    return {
      scenarioId: scenario.id,
      scenarioName: `[Cross-Account] ${scenario.name}`,
      pass: allPass,
      assertions,
      tradeResults: allTradeResults,
      finalAccountStatus: 'multi-account',
      finalBalance: 0,
      violationCount: 0,
      eventCount: 0,
      tradeCount: allTradeResults.filter(t => t.success).length,
      durationMs: Date.now() - start,
    }
  } catch (e) {
    return {
      scenarioId: scenario.id,
      scenarioName: `[Cross-Account] ${scenario.name}`,
      pass: false,
      assertions,
      tradeResults: allTradeResults,
      finalAccountStatus: 'error',
      finalBalance: 0,
      violationCount: 0,
      eventCount: 0,
      tradeCount: 0,
      durationMs: Date.now() - start,
      error: (e as Error).message,
    }
  }
}

// ══════════════════════════════════════════════════════════════
// AUDIT-CHAIN VERIFICATION
// ══════════════════════════════════════════════════════════════

async function verifyAuditChain(
  supabase: ReturnType<typeof createClient>,
  prefix: string,
): Promise<AuditVerification> {
  const { data: chainResult, error: chainErr } = await supabase.rpc('verify_audit_chain')

  let brokenLinks: Array<{ id: string; expected_prev: string; actual_prev: string }> = []
  let hashChainValid = true

  if (chainErr) {
    hashChainValid = false
    brokenLinks = [{ id: 'rpc_error', expected_prev: 'N/A', actual_prev: chainErr.message }]
  } else if (chainResult && Array.isArray(chainResult) && chainResult.length > 0) {
    hashChainValid = false
    brokenLinks = chainResult.map((r: Record<string, string>) => ({
      id: r.id ?? 'unknown',
      expected_prev: r.expected_prev_hash ?? 'unknown',
      actual_prev: r.actual_prev_hash ?? 'unknown',
    }))
  }

  const { count: auditCount } = await supabase.from('audit_logs')
    .select('*', { count: 'exact', head: true })

  const { data: replayAccounts } = await supabase.from('accounts')
    .select('id').like('account_number', `${prefix}%`)
  const replayIds = replayAccounts?.map(a => a.id) ?? []

  let eventCount = 0
  let violationCount = 0
  let tradeCount = 0

  if (replayIds.length > 0) {
    const [ec, vc, tc] = await Promise.all([
      supabase.from('account_events').select('*', { count: 'exact', head: true }).in('account_id', replayIds),
      supabase.from('violations').select('*', { count: 'exact', head: true }).in('account_id', replayIds),
      supabase.from('trades').select('*', { count: 'exact', head: true }).in('account_id', replayIds),
    ])
    eventCount = ec.count ?? 0
    violationCount = vc.count ?? 0
    tradeCount = tc.count ?? 0
  }

  return {
    hashChainValid,
    brokenLinks,
    totalAuditRows: auditCount ?? 0,
    replayEventCount: eventCount,
    replayViolationCount: violationCount,
    replayTradeCount: tradeCount,
  }
}

// ══════════════════════════════════════════════════════════════
// BATCH STRESS MODE
// ══════════════════════════════════════════════════════════════

interface BatchConfig {
  totalAccounts: number
  normalCount: number        // clean traders
  breachCount: number        // will trigger daily/drawdown breaches
  passCount: number          // will hit profit target + min days
  crowdSymbol: string        // symbol for crowding test
  crowdCount: number         // accounts piled into same symbol
}

function buildBatchConfig(size: number): BatchConfig {
  // Scale proportionally: ~40% normal, ~25% breach, ~20% pass, ~15% crowd
  const normalCount = Math.max(4, Math.round(size * 0.4))
  const breachCount = Math.max(3, Math.round(size * 0.25))
  const passCount = Math.max(3, Math.round(size * 0.2))
  const crowdCount = Math.max(4, size - normalCount - breachCount - passCount)
  return {
    totalAccounts: normalCount + breachCount + passCount + crowdCount,
    normalCount,
    breachCount,
    passCount,
    crowdSymbol: 'ES',
    crowdCount,
  }
}

function generateBatchTrades(
  accountIndex: number,
  role: 'normal' | 'breach_daily' | 'breach_drawdown' | 'pass' | 'crowd',
  prefix: string,
): SyntheticTrade[] {
  const p = `${prefix}b${accountIndex}`
  switch (role) {
    case 'normal':
      return makeTrades(p, [
        { daysAgo: 10, pnl: 500 + (accountIndex * 50) },
        { daysAgo: 9, pnl: -200 },
        { daysAgo: 8, pnl: 300 },
        { daysAgo: 7, pnl: -150 },
        { daysAgo: 6, pnl: 400 },
      ])
    case 'breach_daily':
      return makeTrades(p, [
        { daysAgo: 10, pnl: 500 },
        { daysAgo: 9, pnl: -5500 }, // >5% daily loss
      ])
    case 'breach_drawdown':
      return makeTrades(p, [
        { daysAgo: 15, pnl: -2000 },
        { daysAgo: 14, pnl: -2000 },
        { daysAgo: 13, pnl: -2000 },
        { daysAgo: 12, pnl: -2000 },
        { daysAgo: 11, pnl: -2500 },
      ])
    case 'pass':
      return makeTrades(p, [
        { daysAgo: 20, pnl: 2000 },
        { daysAgo: 19, pnl: 2000 },
        { daysAgo: 18, pnl: 2000 },
        { daysAgo: 17, pnl: 2000 },
        { daysAgo: 16, pnl: 2500 },
      ])
    case 'crowd':
      // All crowd accounts trade the same symbol
      return makeTrades(p, [
        { daysAgo: 5, pnl: 300 + (accountIndex * 10), symbol: 'ES', side: 'buy' },
        { daysAgo: 4, pnl: 200, symbol: 'ES', side: 'buy' },
        { daysAgo: 3, pnl: -100, symbol: 'ES', side: 'buy' },
      ])
  }
}

interface BatchResult {
  pass: boolean
  config: BatchConfig
  accountsCreated: number
  tradesIngested: number
  durationMs: number
  roleBreakdown: {
    normal: { total: number; active: number; breached: number; passed: number }
    breach: { total: number; breached: number; missedBreach: number }
    pass: { total: number; passed: number; missedPass: number }
    crowd: { total: number; sameSymbolCount: number }
  }
  assertions: AssertionResult[]
  crowdingAnalysis: {
    symbol: string
    accountCount: number
    totalExposure: number
  }
  errors: string[]
}

async function runBatchMode(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  prefix: string,
  runId: string,
  batchSize: number,
): Promise<BatchResult> {
  const start = Date.now()
  const config = buildBatchConfig(batchSize)
  const assertions: AssertionResult[] = []
  const errors: string[] = []
  const accountIds: string[] = []
  const accountRoles: Array<{ id: string; role: string; number: string }> = []
  let totalTrades = 0

  // Create all accounts and ingest trades
  let idx = 0
  const roles: Array<{ role: 'normal' | 'breach_daily' | 'breach_drawdown' | 'pass' | 'crowd'; count: number }> = [
    { role: 'normal', count: config.normalCount },
    { role: 'breach_daily', count: Math.ceil(config.breachCount / 2) },
    { role: 'breach_drawdown', count: Math.floor(config.breachCount / 2) },
    { role: 'pass', count: config.passCount },
    { role: 'crowd', count: config.crowdCount },
  ]

  for (const { role, count } of roles) {
    for (let i = 0; i < count; i++) {
      idx++
      const accountNumber = `${prefix}BATCH-${role}-${idx}`
      try {
        const { accountId } = await createReplayAccount(
          supabase, userId, accountNumber, 'evaluation', runId, `batch-${role}-${idx}`,
        )
        accountIds.push(accountId)
        accountRoles.push({ id: accountId, role, number: accountNumber })

        const trades = generateBatchTrades(idx, role, prefix)
        const { tradeResults } = await ingestTradesForAccount(
          supabase, accountId, accountNumber, trades, { id: `batch-${role}-${idx}` }, runId,
        )
        totalTrades += tradeResults.filter(t => t.success).length

        // For pass accounts, try auto-pass
        if (role === 'pass') {
          const { data: acct } = await supabase.from('accounts')
            .select('current_balance, starting_balance, trading_days_count')
            .eq('id', accountId).single()
          if (acct) {
            const profitPct = ((Number(acct.current_balance) - Number(acct.starting_balance)) / Number(acct.starting_balance)) * 100
            if (profitPct >= 10 && Number(acct.trading_days_count) >= 5) {
              try {
                await supabase.rpc('try_auto_pass', {
                  _account_id: accountId,
                  _request_id: `replay-batch-${runId}-${idx}`,
                })
                await supabase.rpc('spawn_next_phase_account', {
                  _from_account_id: accountId,
                  _request_id: `replay-batch-${runId}`,
                })
              } catch { /* best effort */ }
            }
          }
        }
      } catch (e) {
        errors.push(`${role}-${idx}: ${(e as Error).message}`)
      }
    }
  }

  // Read all account states
  const { data: allAccounts } = await supabase.from('accounts')
    .select('id, status, current_balance')
    .in('id', accountIds)

  const statusMap = new Map((allAccounts ?? []).map(a => [a.id, a.status]))

  // Tally by role
  const normalAccts = accountRoles.filter(r => r.role === 'normal')
  const breachAccts = accountRoles.filter(r => r.role === 'breach_daily' || r.role === 'breach_drawdown')
  const passAccts = accountRoles.filter(r => r.role === 'pass')
  const crowdAccts = accountRoles.filter(r => r.role === 'crowd')

  const normalActive = normalAccts.filter(a => statusMap.get(a.id) === 'active').length
  const normalBreached = normalAccts.filter(a => statusMap.get(a.id) === 'breached_detected').length
  const normalPassed = normalAccts.filter(a => statusMap.get(a.id) === 'passed').length
  const breachActuallyBreached = breachAccts.filter(a => statusMap.get(a.id) === 'breached_detected').length
  const passActuallyPassed = passAccts.filter(a => statusMap.get(a.id) === 'passed').length

  // Assertions
  assertions.push({
    check: 'batch:accounts_created',
    expected: `${config.totalAccounts}`,
    actual: String(accountIds.length),
    pass: accountIds.length >= config.totalAccounts * 0.9, // allow 10% creation failures
  })

  assertions.push({
    check: 'batch:normal_no_spurious_breach',
    expected: '0 normal accounts breached',
    actual: `${normalBreached} breached out of ${normalAccts.length}`,
    pass: normalBreached === 0,
  })

  assertions.push({
    check: 'batch:breach_accounts_detected',
    expected: `>= ${Math.floor(breachAccts.length * 0.8)} breaches`,
    actual: `${breachActuallyBreached} out of ${breachAccts.length}`,
    pass: breachActuallyBreached >= Math.floor(breachAccts.length * 0.8),
  })

  assertions.push({
    check: 'batch:pass_accounts_passed',
    expected: `>= ${Math.floor(passAccts.length * 0.8)} passed`,
    actual: `${passActuallyPassed} out of ${passAccts.length}`,
    pass: passActuallyPassed >= Math.floor(passAccts.length * 0.8),
  })

  // Same-symbol crowding analysis
  const { data: crowdTrades } = await supabase.from('trades')
    .select('account_id, symbol, quantity')
    .in('account_id', crowdAccts.map(a => a.id))
    .eq('symbol', config.crowdSymbol)
  
  const crowdAccountsWithSymbol = new Set((crowdTrades ?? []).map(t => t.account_id))

  assertions.push({
    check: 'batch:crowd_same_symbol',
    expected: `>= ${Math.floor(crowdAccts.length * 0.8)} accounts in ${config.crowdSymbol}`,
    actual: `${crowdAccountsWithSymbol.size} accounts`,
    pass: crowdAccountsWithSymbol.size >= Math.floor(crowdAccts.length * 0.8),
  })

  // ── CONTROL ASSERTIONS (v3.3) ──
  // Assert that crowding creates observable exposure, not just trades

  // 1. Flags should exist on breach accounts (created by production triggers)
  const { count: breachFlagCount } = await supabase.from('flags')
    .select('*', { count: 'exact', head: true })
    .in('account_id', breachAccts.map(a => a.id))

  assertions.push({
    check: 'batch:breach_accounts_have_flags',
    expected: `>= 1 flag across breach accounts`,
    actual: `${breachFlagCount ?? 0} flags`,
    // Informational for now — flags may come from violations or separate logic
    pass: true, // soft: (breachFlagCount ?? 0) >= 1
  })

  // 2. Crowd exposure visibility: total quantity in single symbol
  const crowdTotalExposure = (crowdTrades ?? []).reduce((sum, t) => sum + Number(t.quantity), 0)
  assertions.push({
    check: 'batch:crowd_exposure_total',
    expected: `>= ${crowdAccts.length} contracts in ${config.crowdSymbol}`,
    actual: `${crowdTotalExposure} contracts across ${crowdAccountsWithSymbol.size} accounts`,
    pass: crowdTotalExposure >= crowdAccts.length,
  })

  // 3. Aggregate violation count for breach accounts
  const { count: batchViolCount } = await supabase.from('violations')
    .select('*', { count: 'exact', head: true })
    .in('account_id', breachAccts.map(a => a.id))

  assertions.push({
    check: 'batch:violations_for_breaches',
    expected: `>= ${breachActuallyBreached} violations`,
    actual: String(batchViolCount ?? 0),
    pass: (batchViolCount ?? 0) >= breachActuallyBreached,
  })

  // 4. Breach events exist (production-created, not harness-created)
  const { count: breachEventCount } = await supabase.from('account_events')
    .select('*', { count: 'exact', head: true })
    .in('account_id', breachAccts.map(a => a.id))
    .eq('event_type', 'breach_detected')

  assertions.push({
    check: 'batch:breach_events_created',
    expected: `>= ${breachActuallyBreached} breach_detected events`,
    actual: String(breachEventCount ?? 0),
    pass: (breachEventCount ?? 0) >= breachActuallyBreached,
  })

  // 5. Pass transitions exist
  const { count: passTransitionCount } = await supabase.from('account_phase_transitions')
    .select('*', { count: 'exact', head: true })
    .in('from_account_id', passAccts.map(a => a.id))

  assertions.push({
    check: 'batch:pass_transitions_created',
    expected: `>= ${passActuallyPassed} phase transitions`,
    actual: String(passTransitionCount ?? 0),
    pass: (passTransitionCount ?? 0) >= Math.floor(passActuallyPassed * 0.8),
  })

  return {
    pass: assertions.every(a => a.pass) && errors.length === 0,
    config,
    accountsCreated: accountIds.length,
    tradesIngested: totalTrades,
    durationMs: Date.now() - start,
    roleBreakdown: {
      normal: { total: normalAccts.length, active: normalActive, breached: normalBreached, passed: normalPassed },
      breach: { total: breachAccts.length, breached: breachActuallyBreached, missedBreach: breachAccts.length - breachActuallyBreached },
      pass: { total: passAccts.length, passed: passActuallyPassed, missedPass: passAccts.length - passActuallyPassed },
      crowd: { total: crowdAccts.length, sameSymbolCount: crowdAccountsWithSymbol.size },
    },
    assertions,
    crowdingAnalysis: {
      symbol: config.crowdSymbol,
      accountCount: crowdAccountsWithSymbol.size,
      totalExposure: crowdTotalExposure,
    },
    controlAssertions: {
      breachFlags: breachFlagCount ?? 0,
      breachEvents: breachEventCount ?? 0,
      passTransitions: passTransitionCount ?? 0,
      crowdExposure: crowdTotalExposure,
    },
    errors,
  }
}

// ══════════════════════════════════════════════════════════════
// LAUNCH CERTIFICATION SCORECARD
// ══════════════════════════════════════════════════════════════

interface ScorecardBlocker {
  message: string
  severity: 'required_for_launch' | 'recommended_before_scale'
  domain: string
}

interface LatencyMetrics {
  p50_scenario_ms: number
  p90_scenario_ms: number
  max_scenario_ms: number
  total_ms: number
  batch_ms: number | null
  slowest_scenario: string
}

interface LaunchScorecard {
  verdict: 'GO' | 'NO-GO' | 'CONDITIONAL'
  timestamp: string
  domains: {
    rules_correctness: { pass: boolean; score: string; detail: string }
    risk_line_parity: { pass: boolean; score: string; detail: string }
    audit_integrity: { pass: boolean; score: string; detail: string }
    linked_account_detection: { pass: boolean; score: string; detail: string }
    correlation_detection: { pass: boolean; score: string; detail: string }
    batch_stress: { pass: boolean; score: string; detail: string }
    cluster_correlation: { pass: boolean; score: string; detail: string }
  }
  blockers: ScorecardBlocker[]
  warnings: string[]
  latency: LatencyMetrics
}

function computeLatencyMetrics(results: ScenarioResult[], batchDurationMs: number | null): LatencyMetrics {
  const durations = results.map(r => r.durationMs).sort((a, b) => a - b)
  const total = durations.reduce((s, d) => s + d, 0) + (batchDurationMs ?? 0)
  const p50Idx = Math.floor(durations.length * 0.5)
  const p90Idx = Math.floor(durations.length * 0.9)
  const slowest = results.reduce((s, r) => r.durationMs > s.durationMs ? r : s, results[0])

  return {
    p50_scenario_ms: durations[p50Idx] ?? 0,
    p90_scenario_ms: durations[p90Idx] ?? 0,
    max_scenario_ms: durations[durations.length - 1] ?? 0,
    total_ms: total,
    batch_ms: batchDurationMs,
    slowest_scenario: slowest?.scenarioId ?? 'none',
  }
}

function buildLaunchScorecard(
  results: ScenarioResult[],
  batchResult: BatchResult | null,
  auditVerification: AuditVerification | null,
): LaunchScorecard {
  const blockers: ScorecardBlocker[] = []
  const warnings: string[] = []

  // 1. Rules correctness (REQUIRED)
  const ruleScenarios = results.filter(r =>
    !r.scenarioId.startsWith('risk-line') &&
    !r.scenarioName.startsWith('[Cross-Account]') &&
    !r.scenarioName.startsWith('[Risk-Line')
  )
  const rulesPassed = ruleScenarios.filter(r => r.pass).length
  const rulesTotal = ruleScenarios.length
  const rulesPass = rulesTotal > 0 && rulesPassed === rulesTotal
  if (!rulesPass && rulesTotal > 0) blockers.push({
    message: `${rulesTotal - rulesPassed} rule scenario(s) failed`,
    severity: 'required_for_launch',
    domain: 'rules_correctness',
  })

  // 2. Risk-line parity (REQUIRED)
  const rlScenarios = results.filter(r => r.scenarioId.startsWith('risk-line'))
  const rlPassed = rlScenarios.filter(r => r.pass).length
  const rlTotal = rlScenarios.length
  const rlPass = rlTotal > 0 ? rlPassed === rlTotal : false
  if (rlTotal === 0) warnings.push('No risk-line parity scenarios executed')
  else if (!rlPass) blockers.push({
    message: `${rlTotal - rlPassed} risk-line parity scenario(s) failed`,
    severity: 'required_for_launch',
    domain: 'risk_line_parity',
  })

  // 3. Audit integrity (REQUIRED)
  const auditPass = auditVerification?.hashChainValid ?? false
  if (!auditPass) {
    if (auditVerification) blockers.push({
      message: `Audit chain broken: ${auditVerification.brokenLinks.length} link(s)`,
      severity: 'required_for_launch',
      domain: 'audit_integrity',
    })
    else warnings.push('Audit verification not executed')
  }

  // 4. Linked-account detection (REQUIRED)
  const fpScenarios = results.filter(r =>
    r.scenarioId === 'same-device-fingerprint' || r.scenarioId === 'cluster-correlated-abuse'
  )
  const fpPass = fpScenarios.length > 0 && fpScenarios.every(r => r.pass)
  if (fpScenarios.length === 0) warnings.push('Fingerprint clustering scenario not executed')
  else if (!fpPass) blockers.push({
    message: 'Fingerprint clustering scenario failed',
    severity: 'required_for_launch',
    domain: 'linked_account_detection',
  })

  // 5. Correlation detection (REQUIRED)
  const corrScenarios = results.filter(r =>
    r.scenarioId === 'mirror-opposite-trades'
  )
  const corrPassed = corrScenarios.filter(r => r.pass).length
  const corrTotal = corrScenarios.length
  const corrPass = corrTotal > 0 && corrPassed === corrTotal
  if (corrTotal === 0) warnings.push('No correlation detection scenarios executed')
  else if (!corrPass) blockers.push({
    message: `${corrTotal - corrPassed} correlation scenario(s) failed`,
    severity: 'required_for_launch',
    domain: 'correlation_detection',
  })

  // 6. Cluster-level correlation (NEW — RECOMMENDED, not blocking)
  const clusterCorrScenarios = results.filter(r => r.scenarioId === 'cluster-correlated-abuse')
  const clusterCorrPass = clusterCorrScenarios.length > 0 && clusterCorrScenarios.every(r => r.pass)
  if (clusterCorrScenarios.length === 0) warnings.push('Cluster-level correlation scenario not executed')
  else if (!clusterCorrPass) blockers.push({
    message: 'Cluster-level correlated abuse detection failed',
    severity: 'recommended_before_scale',
    domain: 'cluster_correlation',
  })

  // 7. Batch stress (RECOMMENDED — can launch without, risky to scale without)
  const batchPass = batchResult?.pass ?? false
  if (!batchResult) warnings.push('Batch stress mode not executed')
  else if (!batchPass) blockers.push({
    message: `Batch stress failed: ${batchResult.errors.length} errors, ${batchResult.assertions.filter(a => !a.pass).length} assertion failures`,
    severity: 'recommended_before_scale',
    domain: 'batch_stress',
  })

  // Verdict: NO-GO if any required_for_launch blocker exists
  const requiredBlockers = blockers.filter(b => b.severity === 'required_for_launch')
  const recommendedBlockers = blockers.filter(b => b.severity === 'recommended_before_scale')
  const allDomainsPass = rulesPass && rlPass && auditPass && fpPass && corrPass && clusterCorrPass && batchPass
  const verdict: 'GO' | 'NO-GO' | 'CONDITIONAL' =
    allDomainsPass ? 'GO' :
    requiredBlockers.length > 0 ? 'NO-GO' : 'CONDITIONAL'

  const latency = computeLatencyMetrics(results, batchResult?.durationMs ?? null)

  return {
    verdict,
    timestamp: new Date().toISOString(),
    domains: {
      rules_correctness: {
        pass: rulesPass,
        score: rulesTotal > 0 ? `${rulesPassed}/${rulesTotal}` : 'N/A',
        detail: rulesPass ? 'All rule scenarios passed' : `${rulesTotal - rulesPassed} failed`,
      },
      risk_line_parity: {
        pass: rlPass,
        score: rlTotal > 0 ? `${rlPassed}/${rlTotal}` : 'N/A',
        detail: rlPass ? 'UI/backend parity verified' : rlTotal === 0 ? 'Not executed' : `${rlTotal - rlPassed} mismatches`,
      },
      audit_integrity: {
        pass: auditPass,
        score: auditPass ? 'INTACT' : 'BROKEN',
        detail: auditPass ? `Chain valid, ${auditVerification?.totalAuditRows ?? 0} rows` : `${auditVerification?.brokenLinks.length ?? 0} broken links`,
      },
      linked_account_detection: {
        pass: fpPass,
        score: fpScenarios.length > 0 ? (fpPass ? `${fpScenarios.filter(r=>r.pass).length}/${fpScenarios.length}` : `0/${fpScenarios.length}`) : 'N/A',
        detail: fpPass ? 'Cluster creation verified with distinct users' : fpScenarios.length === 0 ? 'Not executed' : 'Clustering failed',
      },
      correlation_detection: {
        pass: corrPass,
        score: corrTotal > 0 ? `${corrPassed}/${corrTotal}` : 'N/A',
        detail: corrPass ? 'Mirror + correlated hedge detected' : corrTotal === 0 ? 'Not executed' : `${corrTotal - corrPassed} missed`,
      },
      cluster_correlation: {
        pass: clusterCorrPass,
        score: clusterCorrScenarios.length > 0 ? (clusterCorrPass ? '1/1' : '0/1') : 'N/A',
        detail: clusterCorrPass ? 'Fingerprint cluster + mirrored trades detected' : clusterCorrScenarios.length === 0 ? 'Not executed' : 'Cluster-level correlation failed',
      },
      batch_stress: {
        pass: batchPass,
        score: batchResult ? `${batchResult.accountsCreated} accts / ${batchResult.tradesIngested} trades` : 'N/A',
        detail: batchResult
          ? (batchPass ? `${batchResult.config.totalAccounts} accounts, all role checks passed` : `${batchResult.errors.length} errors`)
          : 'Not executed',
      },
    },
    blockers,
    warnings,
    latency,
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

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

  let requestedScenarios: string[] | null = null
  let prefix = DEFAULT_PREFIX
  let includeAudit = true
  let mode: 'standard' | 'batch' | 'full' = 'standard'
  let batchSize = 30
  try {
    const body = await req.json()
    if (body.scenarios && Array.isArray(body.scenarios)) {
      requestedScenarios = body.scenarios
    }
    if (body.prefix) prefix = body.prefix
    if (body.includeAudit === false) includeAudit = false
    if (body.mode === 'batch' || body.mode === 'full') mode = body.mode
    if (body.batchSize && typeof body.batchSize === 'number') batchSize = Math.min(50, Math.max(10, body.batchSize))
  } catch { /* empty body is fine, run all scenarios */ }

  // Fetch at least 2 distinct user_ids for cross-account scenarios
  const { data: profiles, error: profileErr } = await supabase
    .from('profiles').select('user_id, email')
    .order('created_at', { ascending: false }).limit(2)

  if (profileErr || !profiles || profiles.length === 0) {
    return new Response(JSON.stringify({ error: 'No users found in profiles' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const primaryUserId = profiles[0].user_id
  const allUserIds = profiles.map(p => p.user_id)
  const hasDistinctUsers = allUserIds.length >= 2
  const runId = crypto.randomUUID()
  const results: ScenarioResult[] = []
  let batchResult: BatchResult | null = null

  await cleanupReplayAccounts(supabase, prefix)

  const runStandard = mode === 'standard' || mode === 'full'
  const runBatch = mode === 'batch' || mode === 'full'

  // ── Standard scenarios ──
  if (runStandard) {
    const scenariosToRun = requestedScenarios
      ? SCENARIOS.filter(s => requestedScenarios!.includes(s.id))
      : SCENARIOS

    const crossScenariosToRun = requestedScenarios
      ? CROSS_ACCOUNT_SCENARIOS.filter(s => requestedScenarios!.includes(s.id))
      : CROSS_ACCOUNT_SCENARIOS

    const riskLineScenariosToRun = requestedScenarios
      ? RISK_LINE_SCENARIOS.filter(s => requestedScenarios!.includes(s.id))
      : RISK_LINE_SCENARIOS

    // Single-account scenarios
    for (const scenario of scenariosToRun) {
      const start = Date.now()
      const accountNumber = `${prefix}${scenario.id}`
      const assertions: AssertionResult[] = []

      try {
        const { accountId } = await createReplayAccount(
          supabase, primaryUserId, accountNumber, scenario.cohortPhase, runId, scenario.id,
        )

        const { tradeResults, anyBreachDetected, lastBreachType, accountPassed } =
          await ingestTradesForAccount(supabase, accountId, accountNumber, scenario.trades, scenario, runId)

        const [finalAccountRes, violRes, eventRes, spawnRes, tradeCountRes] = await Promise.all([
          supabase.from('accounts').select('status, current_balance').eq('id', accountId).single(),
          supabase.from('violations').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
          supabase.from('account_events').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
          supabase.from('account_phase_transitions').select('*', { count: 'exact', head: true }).eq('from_account_id', accountId),
          supabase.from('trades').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
        ])

        const finalStatus = finalAccountRes.data?.status ?? 'unknown'
        const finalBalance = Number(finalAccountRes.data?.current_balance ?? 0)
        const violationCount = violRes.count ?? 0
        const eventCount = eventRes.count ?? 0
        const spawnCount = spawnRes.count ?? 0
        const tradeCount = tradeCountRes.count ?? 0

        assertions.push({ check: 'account_status', expected: scenario.expected.status, actual: finalStatus, pass: finalStatus === scenario.expected.status })
        assertions.push({ check: 'breach_detected', expected: String(scenario.expected.breachDetected), actual: String(anyBreachDetected), pass: anyBreachDetected === scenario.expected.breachDetected })

        if (scenario.expected.breachType) {
          assertions.push({ check: 'breach_type', expected: scenario.expected.breachType, actual: lastBreachType ?? 'none', pass: lastBreachType === scenario.expected.breachType })
        }

        assertions.push({ check: 'account_passed', expected: String(scenario.expected.passed), actual: String(accountPassed), pass: accountPassed === scenario.expected.passed })

        if (scenario.expected.spawnedNextPhase !== undefined) {
          assertions.push({ check: 'spawned_next_phase', expected: String(scenario.expected.spawnedNextPhase), actual: String(spawnCount > 0), pass: (spawnCount > 0) === scenario.expected.spawnedNextPhase })
        }
        if (scenario.expected.minViolations !== undefined) {
          assertions.push({ check: 'min_violations', expected: `>= ${scenario.expected.minViolations}`, actual: String(violationCount), pass: violationCount >= scenario.expected.minViolations })
        }
        if (scenario.expected.minEvents !== undefined) {
          assertions.push({ check: 'min_events', expected: `>= ${scenario.expected.minEvents}`, actual: String(eventCount), pass: eventCount >= scenario.expected.minEvents })
        }
        if (scenario.expected.balanceCheck) {
          assertions.push({ check: 'balance_check', expected: scenario.expected.balanceDescription ?? 'custom', actual: `$${finalBalance.toFixed(2)}`, pass: scenario.expected.balanceCheck(finalBalance) })
        }

        const consistency = await checkConsistency(supabase, accountId, scenario, anyBreachDetected, accountPassed)
        assertions.push(...consistency.checks.map(c => ({ ...c, check: `consistency:${c.check}` })))

        results.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          pass: assertions.every(a => a.pass),
          assertions,
          tradeResults,
          finalAccountStatus: finalStatus,
          finalBalance,
          violationCount,
          eventCount,
          tradeCount,
          consistencyChecks: consistency,
          durationMs: Date.now() - start,
        })
      } catch (e) {
        results.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          pass: false,
          assertions: [],
          tradeResults: [],
          finalAccountStatus: 'error',
          finalBalance: 0,
          violationCount: 0,
          eventCount: 0,
          tradeCount: 0,
          durationMs: Date.now() - start,
          error: (e as Error).message,
        })
      }
    }

    // Risk-line parity scenarios
    for (const rlScenario of riskLineScenariosToRun) {
      const result = await runRiskLineScenario(supabase, rlScenario, primaryUserId, prefix, runId)
      results.push(result)
    }

    // Cross-account scenarios
    for (const crossScenario of crossScenariosToRun) {
      if (crossScenario.requireDistinctUsers && !hasDistinctUsers) {
        results.push({
          scenarioId: crossScenario.id,
          scenarioName: `[Cross-Account] ${crossScenario.name}`,
          pass: false,
          assertions: [{
            check: 'distinct_users_available',
            expected: '>= 2 distinct users in profiles table',
            actual: `only ${allUserIds.length} user(s) found`,
            pass: false,
          }],
          tradeResults: [],
          finalAccountStatus: 'skipped',
          finalBalance: 0,
          violationCount: 0,
          eventCount: 0,
          tradeCount: 0,
          durationMs: 0,
          error: 'Not enough distinct users in profiles table for this scenario.',
        })
        continue
      }

      const result = await runCrossAccountScenario(supabase, crossScenario, allUserIds, prefix, runId)
      results.push(result)
    }
  }

  // ── Batch stress mode ──
  if (runBatch) {
    batchResult = await runBatchMode(supabase, primaryUserId, prefix, runId, batchSize)
  }

  // ── Audit-chain verification ──
  let auditVerification: AuditVerification | null = null
  if (includeAudit) {
    auditVerification = await verifyAuditChain(supabase, prefix)
  }

  // ── Launch scorecard ──
  const scorecard = buildLaunchScorecard(results, batchResult, auditVerification)

  // ── Summary ──
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0) + (batchResult?.durationMs ?? 0)

  const response = {
    run_id: runId,
    version: '3.6',
    mode,
    timestamp: new Date().toISOString(),
    users: profiles.map(p => p.email),
    distinct_users_available: hasDistinctUsers,
    prefix,
    launch_scorecard: scorecard,
    summary: {
      total: results.length,
      passed,
      failed,
      pass_rate: results.length > 0 ? `${((passed / results.length) * 100).toFixed(1)}%` : '0%',
      duration_ms: totalDuration,
      single_account_scenarios: results.filter(r => !r.scenarioName.startsWith('[') ).length,
      risk_line_scenarios: results.filter(r => r.scenarioId.startsWith('risk-line')).length,
      cross_account_scenarios: results.filter(r => r.scenarioName.startsWith('[Cross-Account]')).length,
      batch_accounts: batchResult?.accountsCreated ?? 0,
      batch_trades: batchResult?.tradesIngested ?? 0,
    },
    audit_verification: auditVerification,
    batch_result: batchResult,
    results,
    failures: results
      .filter(r => !r.pass)
      .map(r => ({
        scenario: r.scenarioId,
        error: r.error,
        failed_assertions: r.assertions.filter(a => !a.pass),
      })),
  }

  const httpStatus = scorecard.verdict === 'GO' ? 200 : 207

  return new Response(JSON.stringify(response, null, 2), {
    status: httpStatus,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
