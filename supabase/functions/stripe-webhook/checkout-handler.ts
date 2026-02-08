import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

// ============================================================
// Tier → Cohort mapping
// ============================================================
const TIER_COHORT_MAP: Record<string, {
  accountSize: number
  cohortName: string
}> = {
  starter: { accountSize: 50_000, cohortName: 'Starter' },
  pro: { accountSize: 100_000, cohortName: 'Pro' },
  elite: { accountSize: 200_000, cohortName: 'Elite' },
}

function generateAccountNumber(): string {
  const date = new Date()
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `EVAL-${ymd}-${rand}`
}

/**
 * Attempt to fulfill a queued checkout: create account + payment txn.
 * Returns { fulfilled: true, accountId } or { fulfilled: false, error }.
 */
export async function attemptFulfillment(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  userId: string,
  tierId: string,
  session: { id: string; payment_intent: string | null; amount_total: number | null; currency: string | null; metadata: Record<string, string> }
): Promise<{ fulfilled: boolean; accountId?: string; error?: string }> {
  const tierConfig = TIER_COHORT_MAP[tierId]
  if (!tierConfig) {
    return { fulfilled: false, error: `Unknown tier_id: ${tierId}` }
  }

  // ── Breaker pre-check (fail-closed) ──
  const { data: breakerState, error: breakerError } = await supabase
    .from('econ_breaker_state')
    .select('evaluations_frozen, breaker_level')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (breakerError || !breakerState) {
    const reason = breakerError
      ? `RPC_ERROR: ${breakerError.message}`
      : 'BREAKER_STATE_MISSING'
    return { fulfilled: false, error: reason }
  }

  if (breakerState.evaluations_frozen) {
    return { fulfilled: false, error: `EVALUATIONS_FROZEN (level=${breakerState.breaker_level})` }
  }

  // ── Cohort lookup ──
  const { data: cohort, error: cohortError } = await supabase
    .from('cohorts')
    .select('*')
    .eq('name', tierConfig.cohortName)
    .eq('is_active', true)
    .eq('intake_active', true)
    .limit(1)
    .maybeSingle()

  if (cohortError || !cohort) {
    return { fulfilled: false, error: `Cohort lookup failed: ${cohortError?.message ?? 'not found'}` }
  }

  // ── Build rule snapshot ──
  const metadata = session.metadata || {}
  const ruleSnapshot = {
    cohort_id: cohort.id,
    cohort_name: cohort.name,
    cohort_version: cohort.version,
    max_daily_loss_percent: cohort.max_daily_loss_percent,
    max_total_drawdown_percent: cohort.max_total_drawdown_percent,
    profit_target_percent: cohort.profit_target_percent,
    min_trading_days: cohort.min_trading_days,
    max_position_size_percent: cohort.max_position_size_percent,
    payout_split_percent: cohort.payout_split_percent,
    max_payout_percent: cohort.max_payout_percent,
    max_payout_absolute: cohort.max_payout_absolute,
    payout_cooldown_days: cohort.payout_cooldown_days,
    min_trading_days_between_payouts: cohort.min_trading_days_between_payouts,
    payout_eligibility_delay_days: cohort.payout_eligibility_delay_days,
    first_payout_cap_amount: cohort.first_payout_cap_amount,
    lifetime_cap_multiple: cohort.lifetime_cap_multiple,
    entry_fee: cohort.entry_fee,
    stripe_session_id: session.id,
    stripe_payment_intent: session.payment_intent,
    disclaimer_version: metadata.disclaimer_version || 'v1',
    product_description: metadata.product_description || 'Simulated trading evaluation access',
    purchased_at: new Date().toISOString(),
  }

  const accountNumber = generateAccountNumber()

  // ── Create account ──
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      cohort_id: cohort.id,
      account_number: accountNumber,
      starting_balance: tierConfig.accountSize,
      current_balance: tierConfig.accountSize,
      highest_balance: tierConfig.accountSize,
      payout_cycle_start_balance: tierConfig.accountSize,
      rule_snapshot: ruleSnapshot,
      status: 'active',
    })
    .select('id')
    .single()

  if (accountError) {
    return { fulfilled: false, error: `Account creation failed: ${accountError.message}` }
  }

  // ── Payment transaction (audit trail) ──
  await supabase.from('payment_transactions').insert({
    user_id: userId,
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || 'usd',
    direction: 'inbound',
    purpose: 'evaluation_purchase',
    provider: 'stripe',
    provider_payment_id: session.payment_intent as string,
    status: 'completed',
    idempotency_key: `stripe:checkout:${session.id}`,
    metadata: {
      tier_id: tierId,
      account_id: account.id,
      account_number: accountNumber,
      stripe_session_id: session.id,
    },
  })

  // ── Mark queue row as fulfilled ──
  await supabase
    .from('checkout_fulfillment_queue')
    .update({
      status: 'fulfilled',
      fulfilled_account_id: account.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queueId)

  console.log(`Account created: id=${account.id} number=${accountNumber} tier=${tierId} user=${userId}`)
  return { fulfilled: true, accountId: account.id }
}

/**
 * Handle checkout.session.completed:
 * 1. Always insert a queue row (idempotent by session_id)
 * 2. Attempt fulfillment
 * 3. If breaker blocks → queue stays 'queued', staff notified
 */
export async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Stripe.Checkout.Session
) {
  const metadata = session.metadata || {}
  const userId = metadata.user_id
  const tierId = metadata.tier_id

  if (!userId || !tierId) {
    console.error('Missing user_id or tier_id in session metadata', { sessionId: session.id })
    return
  }

  console.log(`Processing checkout: user=${userId} tier=${tierId} session=${session.id}`)

  // ── Step 1: Insert queue row (idempotent) ──
  const { data: queueRow, error: queueError } = await supabase
    .from('checkout_fulfillment_queue')
    .upsert(
      {
        stripe_session_id: session.id,
        user_id: userId,
        tier_id: tierId,
        payment_intent: session.payment_intent as string,
        amount_cents: session.amount_total || 0,
        currency: session.currency || 'usd',
        status: 'queued',
      },
      { onConflict: 'stripe_session_id', ignoreDuplicates: true }
    )
    .select('id, status')
    .single()

  if (queueError) {
    // Could be a duplicate where it was already fulfilled
    const { data: existing } = await supabase
      .from('checkout_fulfillment_queue')
      .select('id, status')
      .eq('stripe_session_id', session.id)
      .single()

    if (existing?.status === 'fulfilled') {
      console.log(`Checkout already fulfilled: session=${session.id}`)
      return
    }
    if (!existing) {
      console.error(`Failed to insert fulfillment queue row: ${queueError.message}`)
      return
    }
    // Proceed with existing queued row
    return await tryFulfillAndNotify(supabase, existing.id, userId, tierId, session)
  }

  if (queueRow.status === 'fulfilled') {
    console.log(`Checkout already fulfilled: session=${session.id}`)
    return
  }

  // ── Step 2: Attempt fulfillment ──
  await tryFulfillAndNotify(supabase, queueRow.id, userId, tierId, session)
}

async function tryFulfillAndNotify(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  userId: string,
  tierId: string,
  session: Stripe.Checkout.Session
) {
  const result = await attemptFulfillment(supabase, queueId, userId, tierId, {
    id: session.id,
    payment_intent: session.payment_intent as string | null,
    amount_total: session.amount_total,
    currency: session.currency,
    metadata: session.metadata || {},
  })

  if (result.fulfilled) return

  // ── Update queue with error + increment attempts ──
  await supabase.rpc('increment_fulfillment_attempts' as never, {
    p_queue_id: queueId,
    p_error: result.error,
  } as never).catch(() => {
    // Fallback: direct update if RPC doesn't exist yet
    supabase
      .from('checkout_fulfillment_queue')
      .update({
        last_error: result.error,
        attempts: 1, // will be wrong on retries without RPC, but safe
        updated_at: new Date().toISOString(),
      })
      .eq('id', queueId)
  })

  console.error(
    `BREAKER_INTAKE_BLOCKED: ${result.error}. ` +
    `Customer paid but account NOT created. session=${session.id} user=${userId}. ` +
    `Queued for retry.`
  )

  // Staff notification (idempotent per session)
  await supabase.from('staff_notifications').insert({
    notification_type: 'intake_blocked',
    title: '🚨 Paid checkout blocked by breaker',
    body: `User ${userId} paid for tier ${tierId} but account NOT created. Reason: ${result.error}. Session: ${session.id}. Queued for retry.`,
    data: {
      user_id: userId,
      tier_id: tierId,
      stripe_session_id: session.id,
      block_reason: result.error,
      queue_id: queueId,
    },
    idempotency_key: `intake_blocked:${session.id}`,
  }).catch(notifErr => {
    console.error('Failed to insert intake_blocked notification:', (notifErr as Error).message)
  })
}
