// ============================================================
// Production-Path Seed Runner v2
// ============================================================
// Creates demo accounts by calling canonical RPCs so all
// side-effects (violations, events, transitions, daily stats,
// payout payments) are generated naturally.
//
// Invocation: POST /seed-demo-data  (requires CRON_SECRET or admin JWT)
// Idempotent: safe to rerun (cleans SEEDV2-% artifacts first)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Cohort IDs (from live DB) ──
const EVAL_COHORT_ID = '30c85b00-c613-4d33-83e5-c5af8a8ea6d5'
const VERI_COHORT_ID = '1d28f164-3219-4c05-879d-a2642c15a57e'
const PERF_COHORT_ID = 'e2965581-ada0-4895-be32-4e6d984ea362'

const STARTING_BALANCE = 100000
const PREFIX = 'SEEDV2-'

// ── Trade series builders ──
// Each returns trades that deterministically hit target scenarios.
// trades use net_pnl (pnl after commissions), commission is separate.

interface SyntheticTrade {
  platform_trade_id: string
  symbol: string
  side: string
  qty: number
  entry_price: number
  net_pnl: number       // pnl column in RPC (already net of commissions inside the RPC)
  commission: number
  opened_at: string      // ISO timestamp
  trading_day: string    // YYYY-MM-DD
}

function makeDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(14, 0, 0, 0) // 2pm ET, well within trading day
  return d.toISOString()
}

function tradingDay(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

function makeTrades(seed: string, specs: Array<{ daysAgo: number; pnl: number; symbol?: string }>): SyntheticTrade[] {
  return specs.map((s, i) => ({
    platform_trade_id: `${seed}-trade-${i + 1}`,
    symbol: s.symbol ?? 'NQ',
    side: s.pnl >= 0 ? 'buy' : 'sell',
    qty: 1,
    entry_price: 20000,
    net_pnl: s.pnl,
    commission: 4.50,
    opened_at: makeDate(s.daysAgo),
    trading_day: tradingDay(s.daysAgo),
  }))
}

// Scenario trade series
// Eval starting_balance = 100000, profit_target = 10% = $10,000
// Daily loss limit = 5% = $5,000, Total drawdown = 10% = $10,000
// Min trading days = 5

function evalNearPassTrades(): SyntheticTrade[] {
  // 8 days of trading, $9,500 profit (just below $10k target)
  return makeTrades('eval-near-pass', [
    { daysAgo: 20, pnl: 1500 },
    { daysAgo: 19, pnl: 1200 },
    { daysAgo: 18, pnl: 800 },
    { daysAgo: 17, pnl: 1400 },
    { daysAgo: 16, pnl: 1100 },
    { daysAgo: 15, pnl: -500 },
    { daysAgo: 14, pnl: 2000 },
    { daysAgo: 13, pnl: 2000 },
  ]) // Total: +9500
}

function evalBreachTrades(): SyntheticTrade[] {
  // 4 normal days, then a daily loss breach on day 5
  // Daily loss limit = 5% of current balance
  return makeTrades('eval-breach', [
    { daysAgo: 25, pnl: 500 },
    { daysAgo: 24, pnl: 300 },
    { daysAgo: 23, pnl: -200 },
    { daysAgo: 22, pnl: 400 },
    // Day 5: lose >$5k on one day → breach daily loss
    { daysAgo: 21, pnl: -5200 },
  ])
}

function evalFailTrades(): SyntheticTrade[] {
  // Steady losses that trigger total drawdown breach (>10%)
  return makeTrades('eval-fail', [
    { daysAgo: 30, pnl: -2000 },
    { daysAgo: 29, pnl: -1500 },
    { daysAgo: 28, pnl: 500 },
    { daysAgo: 27, pnl: -2500 },
    { daysAgo: 26, pnl: -1000 },
    { daysAgo: 25, pnl: -500 },
    { daysAgo: 24, pnl: -1500 },
    { daysAgo: 23, pnl: -1600 },
  ]) // Total: -10100 → 89900/100000 → 10.1% drawdown → breach
}

function evalPassTrades(): SyntheticTrade[] {
  // 6 days, hit profit target exactly at $10,200
  return makeTrades('eval-pass', [
    { daysAgo: 40, pnl: 2000 },
    { daysAgo: 39, pnl: 1800 },
    { daysAgo: 38, pnl: 1500 },
    { daysAgo: 37, pnl: 2200 },
    { daysAgo: 36, pnl: 1200 },
    { daysAgo: 35, pnl: 1500 },
  ]) // Total: +10200 → 110200 → 10.2% profit → auto-pass
}

function veriActiveTrades(): SyntheticTrade[] {
  // Veri profit target = 5% = $5,000. Stay below at $3,200
  return makeTrades('veri-active', [
    { daysAgo: 30, pnl: 800 },
    { daysAgo: 29, pnl: 600 },
    { daysAgo: 28, pnl: -200 },
    { daysAgo: 27, pnl: 500 },
    { daysAgo: 26, pnl: 400 },
    { daysAgo: 25, pnl: 300 },
    { daysAgo: 24, pnl: 800 },
  ]) // Total: +3200
}

function veriPassTrades(): SyntheticTrade[] {
  // Veri: 10 min trading days, 5 min profitable days, 5% target = $5,000
  // Need 10+ days with 5+ winning
  return makeTrades('veri-pass', [
    { daysAgo: 50, pnl: 600 },
    { daysAgo: 49, pnl: 500 },
    { daysAgo: 48, pnl: -200 },
    { daysAgo: 47, pnl: 400 },
    { daysAgo: 46, pnl: 700 },
    { daysAgo: 45, pnl: -300 },
    { daysAgo: 44, pnl: 800 },
    { daysAgo: 43, pnl: 500 },
    { daysAgo: 42, pnl: -100 },
    { daysAgo: 41, pnl: 600 },
    { daysAgo: 40, pnl: 400 },
    { daysAgo: 39, pnl: 1200 },
  ]) // Total: +5100 → 5.1% → pass. 9 winning days out of 12.
}

function perfEligibleTrades(): SyntheticTrade[] {
  // Performance: no profit target needed, just trade to build profit for payouts
  // Needs payout_eligibility_delay_days=14, so trades must be old enough
  return makeTrades('perf-eligible', [
    { daysAgo: 60, pnl: 400 },
    { daysAgo: 59, pnl: 300 },
    { daysAgo: 58, pnl: 500 },
    { daysAgo: 57, pnl: -200 },
    { daysAgo: 56, pnl: 600 },
    { daysAgo: 55, pnl: 200 },
    { daysAgo: 54, pnl: 700 },
    { daysAgo: 53, pnl: 500 },
  ]) // Total: +3000 → $2400 eligible at 80% split
}

function perfNearCapTrades(): SyntheticTrade[] {
  // Large profit to fund multiple payouts near the lifetime cap
  // Cap = entry_fee * multiple = 149 * 7 = $1,043
  // Will do 3 payouts of ~$300 each = $900 paid, $143 headroom
  return makeTrades('perf-near-cap', [
    { daysAgo: 90, pnl: 500 },
    { daysAgo: 89, pnl: 400 },
    { daysAgo: 88, pnl: 600 },
    { daysAgo: 87, pnl: 300 },
    { daysAgo: 86, pnl: 500 },
    { daysAgo: 85, pnl: 700 },
    { daysAgo: 84, pnl: 400 },
    { daysAgo: 83, pnl: 600 },
  ]) // Total: +4000
}

// ── Main handler ──
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Auth check: CRON_SECRET (env or internal_secrets fallback) or admin JWT
  const authHeader = req.headers.get('authorization') ?? ''
  let cronSecret = Deno.env.get('CRON_SECRET') ?? ''

  // Fallback: read CRON_SECRET from internal_secrets if env var is missing/short
  if (!cronSecret || cronSecret.length < 16) {
    console.warn('CRON_SECRET env var missing/short — falling back to internal_secrets table')
    const tmpUrl = Deno.env.get('SUPABASE_URL')!
    const tmpKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const tmpClient = createClient(tmpUrl, tmpKey, { auth: { persistSession: false } })
    const { data: secretRow } = await tmpClient
      .from('internal_secrets')
      .select('value')
      .eq('key', 'CRON_SECRET')
      .single()
    cronSecret = secretRow?.value ?? ''
  }

  // Also accept service_role key directly (used by Lovable curl tool)
  const svcKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const bearerToken = authHeader.replace('Bearer ', '')

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    // OK — cron-authenticated
  } else if (svcKey && bearerToken === svcKey) {
    // OK — service_role authenticated (internal tooling)
  } else {
    // Check for admin JWT
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // Check admin role
    const adminClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
    const { data: roleCheck } = await adminClient.rpc('has_role', { _user_id: user.id, _role: 'admin' })
    if (!roleCheck) {
      return new Response(JSON.stringify({ error: 'Admin role required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const log: string[] = []
  const errors: string[] = []

  // Fetch seed secret from internal_secrets for seed_submit_payout_request gate
  let seedSecret = ''

  function info(msg: string) { log.push(msg); console.log(msg) }
  function err(msg: string) { errors.push(msg); console.error(msg) }

  try {
    // Fetch seed secret for canonical payout request RPC
    const { data: secretRow } = await supabase
      .from('internal_secrets')
      .select('value')
      .eq('key', 'seed_secret')
      .single()
    seedSecret = secretRow?.value ?? ''
    if (!seedSecret) { throw new Error('No seed_secret found in internal_secrets. Run the migration first.') }
    // ── 0. Find demo user ──
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('user_id, email')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    
    if (profileErr || !profile) {
      throw new Error('No user found in profiles. Create a user via signup first.')
    }
    const userId = profile.user_id
    info(`Using user: ${profile.email} (${userId})`)

    // ── 1. Clean up prior SEEDV2 artifacts ──
    // Delete payouts → payout_payments → trades → daily_stats → events → transitions → violations → accounts
    const { data: oldAccounts } = await supabase
      .from('accounts')
      .select('id')
      .like('account_number', `${PREFIX}%`)
    
    if (oldAccounts && oldAccounts.length > 0) {
      const oldIds = oldAccounts.map(a => a.id)
      
      // Delete in dependency order
      for (const oldId of oldIds) {
        await supabase.from('payout_payments').delete().in('payout_id',
          (await supabase.from('payouts').select('id').eq('account_id', oldId)).data?.map(p => p.id) ?? []
        )
        await supabase.from('payouts').delete().eq('account_id', oldId)
        await supabase.from('account_daily_stats').delete().eq('account_id', oldId)
        await supabase.from('violations').delete().eq('account_id', oldId)
        await supabase.from('account_events').delete().eq('account_id', oldId)
        await supabase.from('trades').delete().eq('account_id', oldId)
      }
      
      // Delete transitions referencing these accounts
      await supabase.from('account_phase_transitions').delete()
        .or(oldIds.map(id => `from_account_id.eq.${id}`).join(','))
      await supabase.from('account_phase_transitions').delete()
        .or(oldIds.map(id => `to_account_id.eq.${id}`).join(','))
      
      // Delete platform_accounts
      for (const oldId of oldIds) {
        await supabase.from('platform_accounts').delete().eq('account_id', oldId)
      }
      
      // Delete accounts themselves
      await supabase.from('accounts').delete().like('account_number', `${PREFIX}%`)
      
      info(`Cleaned up ${oldAccounts.length} old SEEDV2 accounts`)
    }

    // Reset user_cohort_payouts for this user
    await supabase.from('user_cohort_payouts').delete().eq('user_id', userId)
    
    // Reset lifetime_paid_total 
    await supabase.from('profiles').update({ 
      lifetime_paid_total: 0,
      kyc_status: 'verified',
      kyc_legal_name: 'Demo Trader',
      kyc_verified_at: new Date().toISOString(),
    }).eq('user_id', userId)
    info('Reset profile: KYC verified, lifetime_paid_total=0')

    // ── Helper: create account via direct insert (accounts need service_role) ──
    async function createAccount(
      name: string, 
      cohortId: string, 
      opts?: { parentId?: string; rootId?: string; phaseIndex?: number }
    ): Promise<string> {
      const { data, error } = await supabase.from('accounts').insert({
        user_id: userId,
        cohort_id: cohortId,
        account_number: `${PREFIX}${name}`,
        status: 'active',
        starting_balance: STARTING_BALANCE,
        current_balance: STARTING_BALANCE,
        highest_balance: STARTING_BALANCE,
        parent_account_id: opts?.parentId ?? null,
        root_account_id: opts?.rootId ?? null,
        phase_index: opts?.phaseIndex ?? 0,
        payout_cycle_start_balance: STARTING_BALANCE,
        payout_cycle_started_at: new Date().toISOString(),
        rule_snapshot: null, // will be set below
      }).select('id').single()

      if (error) throw new Error(`Create account ${name} failed: ${error.message}`)
      
      // Set rule_snapshot from cohort (mimicking what spawn does)
      const { data: cohort } = await supabase.from('cohorts').select('*').eq('id', cohortId).single()
      if (cohort) {
        await supabase.from('accounts').update({
          rule_snapshot: {
            max_daily_loss_percent: cohort.max_daily_loss_percent,
            max_total_drawdown_percent: cohort.max_total_drawdown_percent,
            profit_target_percent: cohort.profit_target_percent,
            min_trading_days: cohort.min_trading_days,
            max_position_size_percent: cohort.max_position_size_percent,
            max_daily_profit_cap_percent: cohort.max_daily_profit_cap_percent,
            min_profitable_days: cohort.min_profitable_days,
            cohort_phase: cohort.cohort_phase,
          }
        }).eq('id', data.id)
      }

      // Create platform_account mapping
      await supabase.from('platform_accounts').insert({
        account_id: data.id,
        platform_account_id: `${PREFIX}${name}`,
        platform_name: 'tradovate',
      })

      // Emit account_created event
      await supabase.from('account_events').insert({
        account_id: data.id,
        event_type: 'account_created',
        idempotency_key: `seed.created:${data.id}`,
        event_data: { phase: cohort?.cohort_phase ?? 'evaluation', seed: true },
      })

      info(`Created account: ${PREFIX}${name} → ${data.id}`)
      return data.id
    }

    // ── Helper: ingest trades via canonical RPC ──
    // accountName is needed to match the platform_account_id registered in platform_accounts
    async function ingestTrades(accountId: string, accountName: string | null, trades: SyntheticTrade[]): Promise<{ breached: boolean; passed: boolean; spawnedId?: string }> {
      let breached = false
      let passed = false
      let spawnedId: string | undefined

      // Look up platform_account_id from DB (handles spawned accounts correctly)
      let platformAccountId: string
      if (accountName) {
        platformAccountId = `${PREFIX}${accountName}`
      } else {
        const { data: paRow } = await supabase
          .from('platform_accounts')
          .select('platform_account_id')
          .eq('account_id', accountId)
          .limit(1)
          .single()
        if (!paRow?.platform_account_id) {
          throw new Error(`No platform_account_id found for account ${accountId}. Cannot ingest trades without it.`)
        }
        platformAccountId = paRow.platform_account_id
      }

      for (const t of trades) {
        const { data: result, error: rpcErr } = await supabase.rpc('ingest_trade_atomic', {
          p_account_id: accountId,
          p_platform_trade_id: t.platform_trade_id,
          p_platform_account_id: platformAccountId,
          p_symbol: t.symbol,
          p_side: t.side,
          p_quantity: t.qty,
          p_entry_price: t.entry_price,
          p_net_pnl: t.net_pnl,
          p_commission: t.commission,
          p_opened_at: t.opened_at,
          p_raw_payload: { seed: true, trade_id: t.platform_trade_id },
          p_trading_day: t.trading_day,
        })

        if (rpcErr) {
          // Terminal state or duplicate is expected for some scenarios
          if (rpcErr.message?.includes('ACCOUNT_TERMINAL')) {
            info(`  Trade ${t.platform_trade_id}: account already terminal (expected)`)
            continue
          }
          err(`  Trade ${t.platform_trade_id} error: ${rpcErr.message}`)
          continue
        }

        if (result?.duplicate) {
          info(`  Trade ${t.platform_trade_id}: duplicate (idempotent skip)`)
          continue
        }

        // Handle breach detection (post-atomic side effects)
        if (result?.breach_detected) {
          breached = true
          info(`  BREACH: ${result.breach_type} actual=${result.breach_actual}% limit=${result.breach_threshold}%`)
          
          // Insert violation — two partial unique indexes exist:
          //   (account_id, rule_type, trade_id) WHERE trade_id IS NOT NULL
          //   (account_id, rule_type, breach_day) WHERE trade_id IS NULL
          // Supabase JS onConflict can't target partial indexes, so use plain insert
          // and catch 23505 (unique violation) as idempotent success.
          const violationPayload = {
            account_id: accountId,
            trade_id: result.trade_id ?? null,
            platform_trade_id: t.platform_trade_id,
            breach_day: t.trading_day,
            rule_type: result.breach_type,
            description: result.breach_description,
            actual_value: result.breach_actual,
            rule_threshold: result.breach_threshold,
            detected_at: new Date().toISOString(),
          }
          const { error: violErr } = await supabase.from('violations').insert(violationPayload)
          if (violErr && !violErr.message?.includes('duplicate key')) {
            err(`  Violation insert failed: ${violErr.message}`)
          }

          // Insert breach event
          await supabase.from('account_events').upsert({
            account_id: accountId,
            event_type: 'breach_detected',
            idempotency_key: `seed.breach:${accountId}:${result.breach_type}:${result.trade_id}`,
            event_data: {
              rule: result.breach_type,
              current_value_pct: result.breach_actual,
              limit_pct: result.breach_threshold,
              description: result.breach_description,
            },
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
        }

        // ── PRODUCTION-EQUIVALENT AUTO-PASS GATING ──
        // Mirror production ingest-trade: only call try_auto_pass when
        // checkPassEligibility conditions are met (profit target + min trading days).
        // This prevents the seed from auto-passing accounts that shouldn't pass yet.
        if (!result?.breach_detected && result?.previous_status === 'active') {
          const rules = result.rule_snapshot as Record<string, unknown> | null
          const profitTargetPct = Number(rules?.profit_target_percent ?? 0)
          const minTradingDays = Number(rules?.min_trading_days ?? 0)
          const startingBalance = Number(result.starting_balance ?? STARTING_BALANCE)
          const newBalance = Number(result.new_balance ?? startingBalance)
          const tradingDaysCount = Number(result.trading_days_count ?? 0)
          const currentProfitPct = ((newBalance - startingBalance) / startingBalance) * 100

          const profitMet = currentProfitPct >= profitTargetPct
          const daysMet = tradingDaysCount >= minTradingDays

          if (profitMet && daysMet) {
            // Check for unconfirmed violations and pending flags
            const { count: violCount } = await supabase.from('violations')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', accountId).is('confirmed_at', null)
            const { count: flagCount } = await supabase.from('flags')
              .select('*', { count: 'exact', head: true })
              .eq('account_id', accountId).eq('status', 'pending')
            
            if ((violCount ?? 0) === 0 && (flagCount ?? 0) === 0) {
              const { data: passResult, error: passErr } = await supabase.rpc('try_auto_pass', {
                _account_id: accountId,
                _request_id: `seed-${accountId}`,
              })

              if (!passErr && passResult?.success && passResult?.updated) {
                passed = true
                info(`  AUTO-PASS triggered (profit: ${currentProfitPct.toFixed(2)}% >= ${profitTargetPct}%, days: ${tradingDaysCount} >= ${minTradingDays})`)

                // Insert passed event
                await supabase.from('account_events').upsert({
                  account_id: accountId,
                  event_type: 'passed',
                  idempotency_key: `seed.passed:${accountId}`,
                  event_data: {
                    phase: (rules?.cohort_phase as string) ?? 'unknown',
                    new_balance: newBalance,
                    profit_pct: currentProfitPct.toFixed(2),
                  },
                }, { onConflict: 'idempotency_key', ignoreDuplicates: true })

                // Spawn next phase
                const { data: spawnResult, error: spawnErr } = await supabase.rpc('spawn_next_phase_account', {
                  _from_account_id: accountId,
                })
                if (!spawnErr && spawnResult?.spawned) {
                  spawnedId = spawnResult.to_account_id
                  info(`  SPAWNED: ${spawnResult.to_account_id} (already_existed: ${spawnResult.already_existed})`)
                } else if (spawnResult && !spawnResult.spawned) {
                  info(`  Spawn skipped: ${spawnResult.reason}`)
                }
              }
            } else {
              info(`  Pass blocked: ${violCount ?? 0} unconfirmed violations, ${flagCount ?? 0} pending flags`)
            }
          }
        }
      }

      return { breached, passed, spawnedId }
    }

    // ── Helper: request payout via canonical seed RPC ──
    async function createPayout(accountId: string, amount: number): Promise<string | null> {
      const { data, error } = await supabase.rpc('seed_submit_payout_request', {
        _account_id: accountId,
        _requested_amount: amount,
        _user_id: userId,
        _seed_secret: seedSecret,
      })

      if (error) {
        err(`Payout seed RPC failed: ${error.message}`)
        return null
      }

      if (!data?.success) {
        err(`Payout seed RPC rejected: ${JSON.stringify(data)}`)
        return null
      }

      const payoutId = data?.payout_id
      info(`  Created payout (canonical seed RPC): ${payoutId} ($${amount})`)
      return payoutId
    }

    // ── Helper: approve + initiate + confirm payout via RPCs ──
    async function processPayoutToCompletion(
      payoutId: string, 
      approverUserId: string,
      paymentRef: string
    ) {
      // Step 1: Approve
      const { data: approveResult, error: approveErr } = await supabase.rpc('approve_payout_atomic', {
        _payout_id: payoutId,
        _approved_by: approverUserId,
        _review_notes: 'Seed v2 demo approval',
      })
      if (approveErr) { err(`Approve failed: ${approveErr.message}`); return }
      if (!approveResult?.success) { err(`Approve rejected: ${JSON.stringify(approveResult)}`); return }
      info(`  Approved payout ${payoutId}`)

      // Step 2: Initiate payment
      const { data: payout } = await supabase.from('payouts').select('amount').eq('id', payoutId).single()
      const { data: initiateResult, error: initErr } = await supabase.rpc('initiate_payout_payment', {
        _payout_id: payoutId,
        _provider: 'wise',
        _amount: payout!.amount,
        _initiated_by: SEED_INITIATOR_ID, // Synthetic UUID: NOT NULL, no FK, != approver
      })
      if (initErr) { err(`Initiate failed: ${initErr.message}`); return }
      if (!initiateResult?.success) { err(`Initiate rejected: ${JSON.stringify(initiateResult)}`); return }
      info(`  Initiated payment ${initiateResult.payment_id}`)

      // Step 3: Confirm (webhook simulation)
      const { data: confirmResult, error: confirmErr } = await supabase.rpc('confirm_payout_payment', {
        _payout_id: payoutId,
        _provider: 'wise',
        _provider_payment_id: `WISE-${paymentRef}`,
        _provider_event_id: `evt-${paymentRef}`,
        _raw_webhook: { seed: true, ref: paymentRef },
        _confirmed_at: new Date().toISOString(),
      })
      if (confirmErr) { err(`Confirm failed: ${confirmErr.message}`); return }
      info(`  Confirmed payment → paid_confirmed`)
    }

    // ══════════════════════════════════════════════
    // SCENARIO EXECUTION
    // ══════════════════════════════════════════════

    // ── S1: Eval Near-Pass (active, just below target) ──
    info('\n=== S1: Eval Near-Pass ===')
    const evalNearPassId = await createAccount('EVAL-NEAR-PASS', EVAL_COHORT_ID)
    await ingestTrades(evalNearPassId, 'EVAL-NEAR-PASS', evalNearPassTrades())

    // ── S2: Eval Breach (daily loss violation) ──
    info('\n=== S2: Eval Breach ===')
    const evalBreachId = await createAccount('EVAL-BREACH', EVAL_COHORT_ID)
    const breachResult = await ingestTrades(evalBreachId, 'EVAL-BREACH', evalBreachTrades())
    // Triggers are disabled during seed, so manually set breached_detected
    if (breachResult.breached) {
      await supabase.from('accounts').update({
        status: 'breached_detected',
        updated_at: new Date().toISOString(),
      }).eq('id', evalBreachId)
      info('  Manually set status → breached_detected (triggers disabled)')
    }

    // ── S3: Eval Fail (drawdown → breached, then confirmed via review-actions) ──
    info('\n=== S3: Eval Fail ===')
    const evalFailId = await createAccount('EVAL-FAIL', EVAL_COHORT_ID)
    const failResult = await ingestTrades(evalFailId, 'EVAL-FAIL', evalFailTrades())
    if (failResult.breached) {
      // Confirm failure (staff action) - direct update since confirm_failure
      // is an edge function action, not a standalone RPC
      await supabase.from('accounts').update({
        status: 'failed_confirmed',
        failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', evalFailId)
      
      await supabase.from('account_events').upsert({
        account_id: evalFailId,
        event_type: 'failure_confirmed',
        idempotency_key: `seed.fail_confirmed:${evalFailId}`,
        event_data: { confirmed_by: 'seed_runner', reason: 'Drawdown breach confirmed' },
      }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      
      await supabase.from('audit_logs').insert({
        account_id: evalFailId,
        action: 'failure_confirmed',
        user_id: userId,
        idempotency_key: `seed.audit.fail:${evalFailId}`,
        prev_hash: 'COMPUTED_BY_TRIGGER',
        row_hash: 'COMPUTED_BY_TRIGGER',
        details: { type: 'seed_failure_confirmation', breach_type: 'max_total_drawdown' },
        reason: 'Seed: drawdown breach confirmed by automation',
      })
      info('  Confirmed failure → failed_confirmed')
    }

    // ── S4: Eval Pass → spawns Verification ──
    info('\n=== S4: Eval Pass → Verification Spawn ===')
    const evalPassId = await createAccount('EVAL-PASS', EVAL_COHORT_ID)
    const passResult = await ingestTrades(evalPassId, 'EVAL-PASS', evalPassTrades())
    
    let spawnedVeriId = passResult.spawnedId
    if (!passResult.passed) {
      // Auto-pass didn't trigger (triggers disabled), force-pass manually
      info('  Auto-pass did not trigger, forcing pass for seed...')
      await supabase.from('accounts').update({
        status: 'passed',
        passed_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', evalPassId)
      
      await supabase.from('account_events').upsert({
        account_id: evalPassId,
        event_type: 'passed',
        idempotency_key: `seed.passed:${evalPassId}`,
        event_data: { phase: 'evaluation', seed_forced: true },
      }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      
      const { data: spawnResult } = await supabase.rpc('spawn_next_phase_account', { _from_account_id: evalPassId })
      spawnedVeriId = spawnResult?.to_account_id
      if (spawnedVeriId) {
        info(`  Force-spawned verification: ${spawnedVeriId}`)
      } else {
        info('  spawn_next_phase_account did not spawn, creating manually...')
      }
    }
    info('\n=== S5: Verification Active ===')
    let veriActiveId: string
    let veriActiveName: string
    if (spawnedVeriId) {
      veriActiveId = spawnedVeriId
      // Use null name → ingestTrades will look up platform_account_id from DB
      await ingestTrades(veriActiveId, null, veriActiveTrades())
    } else {
      veriActiveName = 'VERI-ACTIVE'
      veriActiveId = await createAccount(veriActiveName, VERI_COHORT_ID, {
        parentId: evalPassId,
        rootId: evalPassId,
        phaseIndex: 1,
      })
      await ingestTrades(veriActiveId, veriActiveName, veriActiveTrades())
    }

    // ── S6: Verification Pass → spawns Performance ──
    info('\n=== S6: Verification Pass → Performance Spawn ===')
    const veriPassId = await createAccount('VERI-PASS', VERI_COHORT_ID, {
      parentId: evalPassId,
      rootId: evalPassId,
      phaseIndex: 1,
    })
    const veriPassResult = await ingestTrades(veriPassId, 'VERI-PASS', veriPassTrades())
    
    let spawnedPerfId = veriPassResult.spawnedId
    if (!veriPassResult.passed) {
      // Auto-pass didn't trigger (triggers disabled), force-pass manually
      info('  Veri auto-pass did not trigger, forcing pass for seed...')
      await supabase.from('accounts').update({
        status: 'passed',
        passed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', veriPassId)
      
      await supabase.from('account_events').upsert({
        account_id: veriPassId,
        event_type: 'passed',
        idempotency_key: `seed.passed:${veriPassId}`,
        event_data: { phase: 'verification', seed_forced: true },
      }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      
      // Create phase transition record
      await supabase.from('account_phase_transitions').insert({
        from_account_id: veriPassId,
        from_cohort_id: VERI_COHORT_ID,
        to_account_id: veriPassId, // placeholder, will update if spawn works
        to_cohort_id: PERF_COHORT_ID,
      }).then(() => {}) // ignore errors (transition may already exist)
      
      const { data: spawnResult } = await supabase.rpc('spawn_next_phase_account', { _from_account_id: veriPassId })
      spawnedPerfId = spawnResult?.to_account_id
      if (spawnedPerfId) {
        info(`  Force-spawned performance: ${spawnedPerfId}`)
      } else {
        info('  spawn_next_phase_account did not spawn, creating manually...')
      }
    }

    // ── S7: Performance Eligible (has profit, old enough for payout) ──
    info('\n=== S7: Performance Eligible ===')
    let perfEligibleId: string
    let perfEligibleName: string
    if (spawnedPerfId) {
      perfEligibleId = spawnedPerfId
      // Use null name → ingestTrades will look up platform_account_id from DB
      await ingestTrades(perfEligibleId, null, perfEligibleTrades())
      // Ensure perf account is active (spawn may have set it differently)
      await supabase.from('accounts').update({
        status: 'active',
        passed_at: null,
        payout_cycle_started_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', perfEligibleId)
      info('  Ensured PERF-ELIGIBLE → active')
    } else {
      perfEligibleName = 'PERF-ELIGIBLE'
      perfEligibleId = await createAccount(perfEligibleName, PERF_COHORT_ID, {
        parentId: veriPassId,
        rootId: evalPassId,
        phaseIndex: 2,
      })
      await ingestTrades(perfEligibleId, perfEligibleName, perfEligibleTrades())
    }

    // ── S8: Performance Near-Cap (multiple paid payouts) ──
    info('\n=== S8: Performance Near-Cap (3 paid payouts) ===')
    const perfNearCapId = await createAccount('PERF-NEAR-CAP', PERF_COHORT_ID, {
      parentId: veriPassId,
      rootId: evalPassId,
      phaseIndex: 2,
    })
    await ingestTrades(perfNearCapId, 'PERF-NEAR-CAP', perfNearCapTrades())

    // Create and process 3 payouts (approved → paid → confirmed)
    // Approver must be a real auth.users UUID (payouts.reviewed_by FK)
    // Initiator only needs to be NOT NULL and != approver (no FK on payout_payments.initiated_by or payouts.paid_by)
    const DEMO_APPROVER = userId  // Real demo trader — satisfies reviewed_by FK
    const SEED_INITIATOR_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'  // Synthetic UUID, no FK, != userId
    
    for (let i = 1; i <= 3; i++) {
      info(`  Processing payout ${i}/3...`)
      const payoutAmount = 300
      
      // Set account to a payout-requestable state
      await supabase.from('accounts').update({ 
        status: 'passed',
        passed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', perfNearCapId)

      const payoutId = await createPayout(perfNearCapId, payoutAmount)
      if (payoutId) {
        await processPayoutToCompletion(payoutId, DEMO_APPROVER, `seed-cap-${i}`)
        
        // After payout is paid, the cycle resets. Re-inject profit headroom
        // by lowering payout_cycle_start_balance so next payout sees profit.
        const { data: acctState } = await supabase.from('accounts')
          .select('current_balance')
          .eq('id', perfNearCapId)
          .single()
        if (acctState) {
          await supabase.from('accounts').update({
            payout_cycle_start_balance: acctState.current_balance - 500,
            status: 'passed',
            passed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', perfNearCapId)
        }
      }

      // Wait a tick for timestamp uniqueness
      await new Promise(r => setTimeout(r, 50))
    }

    // Reset PERF-NEAR-CAP to active (perf accounts stay active, not passed)
    await supabase.from('accounts').update({
      status: 'active',
      passed_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', perfNearCapId)
    info('  Reset PERF-NEAR-CAP → active (perf accounts stay active)')

    // ── S9: Performance Payout Requested (pending review) ──
    info('\n=== S9: Performance Payout Requested ===')
    const perfPayoutReqId = await createAccount('PERF-PAYOUT-REQ', PERF_COHORT_ID, {
      parentId: veriPassId,
      rootId: evalPassId,
      phaseIndex: 2,
    })
    await ingestTrades(perfPayoutReqId, 'PERF-PAYOUT-REQ', perfEligibleTrades().map(t => ({
      ...t,
      platform_trade_id: t.platform_trade_id.replace('perf-eligible', 'perf-payout-req'),
    })))
    
    // Temporarily set passed so seed_submit_payout_request RPC accepts it
    await supabase.from('accounts').update({
      status: 'passed',
      passed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', perfPayoutReqId)
    
    const payoutReqPayoutId = await createPayout(perfPayoutReqId, 200)
    
    // Set final state: payout_requested (the canonical status when a payout is pending)
    if (payoutReqPayoutId) {
      await supabase.from('accounts').update({
        status: 'payout_requested',
        updated_at: new Date().toISOString(),
      }).eq('id', perfPayoutReqId)
      info('  Set PERF-PAYOUT-REQ → payout_requested')
    }

    // ══════════════════════════════════════════════
    // VERIFICATION
    // ══════════════════════════════════════════════
    info('\n=== POST-SEED VERIFICATION ===')

    // Count artifacts created through production paths
    const { count: acctCount } = await supabase.from('accounts').select('*', { count: 'exact', head: true }).like('account_number', `${PREFIX}%`)
    const { count: tradeCount } = await supabase.from('trades').select('*', { count: 'exact', head: true }).in('account_id',
      (await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)).data?.map(a => a.id) ?? []
    )
    const { count: statsCount } = await supabase.from('account_daily_stats').select('*', { count: 'exact', head: true }).in('account_id',
      (await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)).data?.map(a => a.id) ?? []
    )
    const { count: eventCount } = await supabase.from('account_events').select('*', { count: 'exact', head: true }).in('account_id',
      (await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)).data?.map(a => a.id) ?? []
    )
    const { count: violationCount } = await supabase.from('violations').select('*', { count: 'exact', head: true }).in('account_id',
      (await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)).data?.map(a => a.id) ?? []
    )
    const { count: transitionCount } = await supabase.from('account_phase_transitions').select('*', { count: 'exact', head: true }).in('from_account_id',
      (await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)).data?.map(a => a.id) ?? []
    )

    const summary = {
      accounts: acctCount ?? 0,
      trades: tradeCount ?? 0,
      daily_stats: statsCount ?? 0,
      events: eventCount ?? 0,
      violations: violationCount ?? 0,
      phase_transitions: transitionCount ?? 0,
    }
    info(`\nArtifact counts: ${JSON.stringify(summary, null, 2)}`)

    // Verify key invariants
    const checks: Array<{ name: string; pass: boolean; detail: string }> = []

    // V1: All breached accounts have violations
    const { data: breachedNoViolation } = await supabase
      .from('accounts')
      .select('id, account_number')
      .like('account_number', `${PREFIX}%`)
      .in('status', ['breached_detected', 'failed_confirmed'])
    
    let v1Pass = true
    for (const ba of breachedNoViolation ?? []) {
      const { count } = await supabase.from('violations').select('*', { count: 'exact', head: true }).eq('account_id', ba.id)
      if (!count || count === 0) { v1Pass = false; break }
    }
    checks.push({ name: 'V1: Breached accounts have violations', pass: v1Pass, detail: `${(breachedNoViolation ?? []).length} breached/failed accounts checked` })

    // V2: All accounts have events
    let v2Fail = 0
    const { data: allSeedAccounts } = await supabase.from('accounts').select('id').like('account_number', `${PREFIX}%`)
    for (const a of allSeedAccounts ?? []) {
      const { count } = await supabase.from('account_events').select('*', { count: 'exact', head: true }).eq('account_id', a.id)
      if (!count || count === 0) v2Fail++
    }
    checks.push({ name: 'V2: All accounts have events', pass: v2Fail === 0, detail: `${v2Fail} accounts missing events` })

    // V3: Veri/Perf accounts have lineage
    const { data: noLineage } = await supabase
      .from('accounts')
      .select('id, account_number')
      .like('account_number', `${PREFIX}%`)
      .in('cohort_id', [VERI_COHORT_ID, PERF_COHORT_ID])
      .or('root_account_id.is.null,parent_account_id.is.null')
    checks.push({ name: 'V3: Veri/Perf have lineage', pass: (noLineage?.length ?? 0) === 0, detail: `${noLineage?.length ?? 0} missing lineage` })

    // V4: Accounts with trades have daily stats
    let v4Fail = 0
    for (const a of allSeedAccounts ?? []) {
      const { count: tc } = await supabase.from('trades').select('*', { count: 'exact', head: true }).eq('account_id', a.id)
      if (tc && tc > 0) {
        const { count: sc } = await supabase.from('account_daily_stats').select('*', { count: 'exact', head: true }).eq('account_id', a.id)
        if (!sc || sc === 0) v4Fail++
      }
    }
    checks.push({ name: 'V4: Trades have daily stats', pass: v4Fail === 0, detail: `${v4Fail} accounts with trades but no stats` })

    // V5: Paid payouts have payment trail
    const { data: paidPayouts } = await supabase
      .from('payouts')
      .select('id, status, account_id')
      .in('status', ['paid', 'paid_confirmed'])
      .in('account_id', (allSeedAccounts ?? []).map(a => a.id))
    
    let v5Fail = 0
    for (const p of paidPayouts ?? []) {
      const { count } = await supabase.from('payout_payments').select('*', { count: 'exact', head: true }).eq('payout_id', p.id)
      if (!count || count === 0) v5Fail++
    }
    checks.push({ name: 'V5: Paid payouts have payment trail', pass: v5Fail === 0, detail: `${v5Fail} paid payouts missing trail` })

    const allPassed = checks.every(c => c.pass)
    info(`\n${'='.repeat(50)}`)
    info(`VERIFICATION: ${allPassed ? '✅ ALL PASSED' : '❌ FAILURES DETECTED'}`)
    for (const c of checks) {
      info(`  ${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`)
    }

    return new Response(JSON.stringify({
      success: true,
      verdict: allPassed ? 'ALL_CHECKS_PASSED' : 'FAILURES_DETECTED',
      summary,
      checks,
      log,
      errors,
    }, null, 2), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(`Fatal: ${msg}`)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error', log, errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
