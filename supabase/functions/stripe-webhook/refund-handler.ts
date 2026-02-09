import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

// Terminal account statuses — skip refund invalidation if already terminal
const TERMINAL_STATUSES = ['failed_confirmed', 'closed']

/**
 * Handle charge.refunded:
 * 1. Idempotency guard — if payment_transactions.status already 'refunded', exit early
 * 2. Invalidate account (set status = 'failed_confirmed', the correct enum value)
 * 3. Write hash-chain-compliant audit log entry
 * 4. Write trader-visible account event
 * 5. Staff notification (idempotent)
 * 6. Mark fulfillment queue row as refunded + clear processing_started_at
 */
export async function handleChargeRefunded(
  supabase: ReturnType<typeof createClient>,
  _stripe: Stripe,
  charge: Stripe.Charge
) {
  const paymentIntentId = charge.payment_intent as string
  if (!paymentIntentId) {
    console.log('Refund event without payment_intent, skipping')
    return
  }

  console.log(`Processing refund: charge=${charge.id} pi=${paymentIntentId}`)

  // ── Step 1: Find the payment transaction ──────────────────────
  const { data: txn } = await supabase
    .from('payment_transactions')
    .select('id, user_id, metadata, status')
    .eq('provider', 'stripe')
    .eq('provider_payment_id', paymentIntentId)
    .eq('purpose', 'evaluation_purchase')
    .limit(1)
    .maybeSingle()

  if (!txn) {
    console.error(`No payment transaction found for pi=${paymentIntentId}`)
    return
  }

  // ── Step 2: Idempotency guard — already processed? ────────────
  if (txn.status === 'refunded') {
    console.log(`Refund already processed for pi=${paymentIntentId}, txn=${txn.id} — skipping`)
    return
  }

  const accountId = (txn.metadata as Record<string, unknown>)?.account_id as string
  if (!accountId) {
    console.error(`No account_id in payment transaction metadata, txn=${txn.id}`)
    return
  }

  // ── Step 3: Check account status — skip if already terminal ───
  const { data: account } = await supabase
    .from('accounts')
    .select('id, status, account_number, user_id')
    .eq('id', accountId)
    .single()

  if (!account) {
    console.error(`Account ${accountId} not found for refund on pi=${paymentIntentId}`)
    return
  }

  const previousStatus = account.status
  const alreadyTerminal = TERMINAL_STATUSES.includes(previousStatus)

  // ── Step 4: Invalidate account (only if not already terminal) ─
  if (!alreadyTerminal) {
    const { error: updateError } = await supabase
      .from('accounts')
      .update({
        status: 'failed_confirmed',
        failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId)

    if (updateError) {
      console.error('Failed to invalidate account on refund:', updateError.message)
      // Don't return — still try to update payment txn and audit
    }
  } else {
    console.log(`Account ${accountId} already in terminal state '${previousStatus}', skipping status update`)
  }

  // ── Step 5: Update payment transaction status ─────────────────
  await supabase
    .from('payment_transactions')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', txn.id)

  // ── Step 6: Audit log (hash-chain compliant, deterministic key) ─
  // prev_hash and row_hash are computed by the DB trigger — never supply placeholders
  const auditIdempotencyKey = `audit.refund_invalidated:${charge.id}:${accountId}`
  const { error: auditErr } = await supabase
    .from('audit_logs')
    .insert({
      account_id: accountId,
      user_id: account.user_id,
      action: 'failure_confirmed' as const,
      idempotency_key: auditIdempotencyKey,
      details: {
        type: 'refund_invalidated',
        charge_id: charge.id,
        payment_intent_id: paymentIntentId,
        previous_status: previousStatus,
        new_status: alreadyTerminal ? previousStatus : 'failed_confirmed',
        already_terminal: alreadyTerminal,
        refund_amount: charge.amount_refunded,
        currency: charge.currency,
      },
      reason: `Account invalidated due to Stripe refund on charge ${charge.id}`,
    })
  if (auditErr) {
    // 23505 = unique_violation (idempotency_key already exists) — safe to ignore
    if (auditErr.code === '23505') {
      console.log(`Audit log already exists for refund ${charge.id}, skipping (idempotent)`)
    } else {
      console.error('Audit log insert failed:', auditErr.message)
    }
  }

  // ── Step 7: Trader-visible account event ──────────────────────
  const eventIdempotencyKey = `acctevt.refund_invalidated:${charge.id}:${accountId}`
  const { error: eventErr } = await supabase
    .from('account_events')
    .insert({
      account_id: accountId,
      event_type: 'failure_confirmed' as const,
      idempotency_key: eventIdempotencyKey,
      event_data: {
        trigger: 'payment_refund',
        previous_status: previousStatus,
        explanation: 'Your account has been invalidated because the payment was refunded.',
        next_step: 'If you believe this is an error, please contact support.',
      },
    })
  if (eventErr) {
    if (eventErr.code === '23505') {
      console.log(`Account event already exists for refund ${charge.id}, skipping (idempotent)`)
    } else {
      console.error('Account event insert failed:', eventErr.message)
    }
  }

  // ── Step 8: Staff notification (idempotent per charge) ────────
  const { error: notifErr } = await supabase
    .from('staff_notifications')
    .insert({
      notification_type: 'refund_processed',
      title: '💸 Refund: Account invalidated',
      body: `Account ${account.account_number || accountId} invalidated due to refund on charge ${charge.id}. Previous status: ${previousStatus}.`,
      data: {
        account_id: accountId,
        charge_id: charge.id,
        payment_intent_id: paymentIntentId,
        previous_status: previousStatus,
        user_id: account.user_id,
      },
      idempotency_key: `refund:${charge.id}`,
    })
  if (notifErr) {
    if (notifErr.code === '23505') {
      console.log(`Staff notification already exists for refund ${charge.id}, skipping`)
    } else {
      console.error('Staff notification insert failed:', notifErr.message)
    }
  }

  // ── Step 9: Mark fulfillment queue row as refunded ─────────────
  const sessionId = (txn.metadata as Record<string, unknown>)?.stripe_session_id as string
  if (sessionId) {
    await supabase
      .from('checkout_fulfillment_queue')
      .update({
        status: 'refunded',
        processing_started_at: null, // Clear to prevent stale-claim re-pickup
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_session_id', sessionId)
  }

  console.log(
    `Refund processed: account=${accountId} charge=${charge.id} pi=${paymentIntentId} ` +
    `previous_status=${previousStatus} new_status=${alreadyTerminal ? previousStatus : 'failed_confirmed'}`
  )
}
