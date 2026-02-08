import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

// ============================================================
// Tier → Cohort mapping (only primitives needed now;
// cohort resolution + snapshot happen in the DB RPC)
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

// ── Error classification ──
// Retryable = breaker freeze, transient DB errors, timeouts
// Terminal  = bad metadata, missing cohort, unknown tier
const RETRYABLE_PATTERNS = [
  'EVALUATIONS_FROZEN',
  'BREAKER',
  'timeout',
  'rate limit',
  'deadlock',
  'could not serialize',
  'connection',
  'too many connections',
  'statement timeout',
]

function isRetryable(err: string): boolean {
  const lower = err.toLowerCase()
  return RETRYABLE_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

/**
 * Handle checkout.session.completed:
 * 1. Upsert queue row (idempotent, no ignoreDuplicates)
 * 2. Claim atomically via RPC (FOR UPDATE + status='processing')
 * 3. Fulfill atomically via DB RPC (breaker + cohort + account + txn + queue)
 * 4. If blocked → classify error, revert to queued or mark failed, notify staff
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

  // ── Step 1: Ensure queue row exists (insert-only, never overwrites status) ──
  const { error: insertErr } = await supabase
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

  // 23505 = unique_violation → row already exists, which is fine (Stripe retry)
  if (insertErr && !insertErr.code?.includes('23505')) {
    console.error(`Queue insert failed: ${insertErr.message}`, { sessionId: session.id })
    return
  }

  // Now read the current state (whether we just inserted or it already existed)
  const { data: queueRow, error: selectErr } = await supabase
    .from('checkout_fulfillment_queue')
    .select('id, status, fulfilled_account_id')
    .eq('stripe_session_id', session.id)
    .single()

  if (selectErr || !queueRow) {
    console.error(`Queue row not found after insert: ${selectErr?.message}`, { sessionId: session.id })
    return
  }

  // Already fulfilled — exit early
  if (queueRow.status === 'fulfilled' && queueRow.fulfilled_account_id) {
    console.log(`Checkout already fulfilled: session=${session.id} account=${queueRow.fulfilled_account_id}`)
    return
  }

  // ── Step 2: Claim the queue row atomically ──
  const { data: claimed, error: claimError } = await supabase
    .rpc('claim_checkout_fulfillment', { p_session_id: session.id })

  if (claimError) {
    console.error(`Claim RPC failed: ${claimError.message}`, { sessionId: session.id })
    return
  }

  const claimRow = Array.isArray(claimed) ? claimed[0] : claimed
  if (!claimRow) {
    console.log(`Checkout not claimable (already fulfilled or processing): session=${session.id}`)
    return
  }

  // ── Step 3: Atomic fulfillment via DB RPC ──
  // Cohort resolution + snapshot + account + txn + queue update all in one transaction.
  const { data: accountId, error: fulfillError } = await supabase
    .rpc('fulfill_checkout_session', {
      p_queue_id: claimRow.id,
      p_user_id: userId,
      p_stripe_session_id: session.id,
      p_payment_intent: (session.payment_intent as string) || '',
      p_amount_cents: session.amount_total || 0,
      p_currency: session.currency || 'usd',
      p_tier_id: tierId,
      p_cohort_name: tierConfig.cohortName,
      p_account_number: generateAccountNumber(),
      p_account_size: tierConfig.accountSize,
      p_disclaimer_version: metadata.disclaimer_version || 'v1',
      p_product_description: metadata.product_description || 'Simulated trading evaluation access',
    })

  if (fulfillError) {
    const errorMsg = fulfillError.message || 'Unknown fulfillment error'
    const retryable = isRetryable(errorMsg)

    // Classify: retryable → back to queued; terminal → failed
    await markQueueError(supabase, claimRow.id, errorMsg, retryable)

    console.error(
      `FULFILLMENT_${retryable ? 'BLOCKED' : 'FAILED'}: ${errorMsg}. ` +
      `session=${session.id} user=${userId}. ${retryable ? 'Queued for retry.' : 'Marked as failed.'}`
    )

    // Staff notification (idempotent per session)
    await supabase.from('staff_notifications').insert({
      notification_type: retryable ? 'intake_blocked' : 'intake_failed',
      title: retryable
        ? '🚨 Paid checkout blocked by breaker'
        : '❌ Checkout fulfillment permanently failed',
      body: `User ${userId} paid for tier ${tierId}. Reason: ${errorMsg}. Session: ${session.id}. ${retryable ? 'Queued for retry.' : 'Requires manual intervention.'}`,
      data: {
        user_id: userId,
        tier_id: tierId,
        stripe_session_id: session.id,
        block_reason: errorMsg,
        queue_id: claimRow.id,
        retryable,
      },
      idempotency_key: `${retryable ? 'intake_blocked' : 'intake_failed'}:${session.id}`,
    }).catch(notifErr => {
      console.error('Failed to insert notification:', (notifErr as Error).message)
    })

    return
  }

  console.log(`Account created atomically: id=${accountId} tier=${tierId} user=${userId} session=${session.id}`)
}

/**
 * Mark a queue row with error info.
 * Retryable errors → back to 'queued' for later retry.
 * Terminal errors → 'failed' to stop retry loops.
 */
async function markQueueError(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  error: string,
  retryable: boolean
) {
  await supabase
    .from('checkout_fulfillment_queue')
    .update({
      status: retryable ? 'queued' : 'failed',
      last_error: error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queueId)
}
