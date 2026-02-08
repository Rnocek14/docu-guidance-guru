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
 * Handle checkout.session.completed:
 * 1. Ensure queue row exists (insert, then select on conflict)
 * 2. Claim atomically via RPC (FOR UPDATE + status='processing')
 * 3. Fulfill atomically via RPC (breaker + account + txn + queue in one txn)
 * 4. If breaker blocks → queue stays 'queued'/'processing', staff notified
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

  const tierConfig = TIER_COHORT_MAP[tierId]
  if (!tierConfig) {
    console.error(`Unknown tier_id: ${tierId}`, { sessionId: session.id })
    return
  }

  console.log(`Processing checkout: user=${userId} tier=${tierId} session=${session.id}`)

  // ── Step 1: Ensure queue row exists (idempotent) ──
  // Insert; if conflict on stripe_session_id, it's fine — we'll select below.
  await supabase
    .from('checkout_fulfillment_queue')
    .insert({
      stripe_session_id: session.id,
      user_id: userId,
      tier_id: tierId,
      payment_intent: session.payment_intent as string,
      amount_cents: session.amount_total || 0,
      currency: session.currency || 'usd',
      status: 'queued',
    })
    .select()
    .maybeSingle() // Don't throw on conflict

  // ── Step 2: Claim the queue row atomically ──
  // This locks the row FOR UPDATE and flips to 'processing'.
  // If already fulfilled or claimed by another worker → returns empty.
  const { data: claimed, error: claimError } = await supabase
    .rpc('claim_checkout_fulfillment', { p_session_id: session.id })

  if (claimError) {
    console.error(`Claim RPC failed: ${claimError.message}`, { sessionId: session.id })
    return
  }

  const claimRow = Array.isArray(claimed) ? claimed[0] : claimed
  if (!claimRow) {
    // Already fulfilled or not claimable
    console.log(`Checkout already fulfilled or not claimable: session=${session.id}`)
    return
  }

  // ── Step 3: Look up cohort ──
  const { data: cohort, error: cohortError } = await supabase
    .from('cohorts')
    .select('*')
    .eq('name', tierConfig.cohortName)
    .eq('is_active', true)
    .eq('intake_active', true)
    .limit(1)
    .maybeSingle()

  if (cohortError || !cohort) {
    await markQueueError(supabase, claimRow.id, `Cohort lookup failed: ${cohortError?.message ?? 'not found'}`)
    return
  }

  // ── Step 4: Build rule snapshot ──
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

  // ── Step 5: Atomic fulfillment (breaker + account + txn + queue in one txn) ──
  const { data: accountId, error: fulfillError } = await supabase
    .rpc('fulfill_checkout_session', {
      p_queue_id: claimRow.id,
      p_user_id: userId,
      p_stripe_session_id: session.id,
      p_payment_intent: (session.payment_intent as string) || '',
      p_amount_cents: session.amount_total || 0,
      p_currency: session.currency || 'usd',
      p_tier_id: tierId,
      p_cohort_id: cohort.id,
      p_account_number: generateAccountNumber(),
      p_account_size: tierConfig.accountSize,
      p_rule_snapshot: ruleSnapshot,
    })

  if (fulfillError) {
    const errorMsg = fulfillError.message || 'Unknown fulfillment error'

    // Revert queue to 'queued' so it can be retried
    await markQueueError(supabase, claimRow.id, errorMsg)

    console.error(
      `FULFILLMENT_FAILED: ${errorMsg}. session=${session.id} user=${userId}. Queued for retry.`
    )

    // Staff notification (idempotent per session)
    await supabase.from('staff_notifications').insert({
      notification_type: 'intake_blocked',
      title: '🚨 Paid checkout blocked',
      body: `User ${userId} paid for tier ${tierId} but account NOT created. Reason: ${errorMsg}. Session: ${session.id}. Queued for retry.`,
      data: {
        user_id: userId,
        tier_id: tierId,
        stripe_session_id: session.id,
        block_reason: errorMsg,
        queue_id: claimRow.id,
      },
      idempotency_key: `intake_blocked:${session.id}`,
    }).catch(notifErr => {
      console.error('Failed to insert intake_blocked notification:', (notifErr as Error).message)
    })

    return
  }

  console.log(`Account created atomically: id=${accountId} tier=${tierId} user=${userId} session=${session.id}`)
}

/**
 * Mark a queue row back to 'queued' with error info so it can be retried.
 */
async function markQueueError(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  error: string
) {
  await supabase
    .from('checkout_fulfillment_queue')
    .update({
      status: 'queued',
      last_error: error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queueId)
}
