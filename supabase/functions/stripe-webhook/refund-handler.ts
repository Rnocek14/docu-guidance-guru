import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

/**
 * Handle charge.refunded — thin wrapper around the atomic
 * `public.handle_charge_refunded` RPC (P0-2).
 *
 * The RPC owns ALL database state transitions in a single transaction:
 *   - locks payment_transactions FOR UPDATE (race-safe under parallel webhooks)
 *   - idempotency via payment_transactions.status + audit idempotency_key
 *   - auto-rejects cancellable payouts + writes per-payout audit
 *   - invalidates the account (if not already terminal)
 *   - marks payment_transactions refunded
 *   - writes hash-chained audit_logs + account_events
 *   - marks the fulfillment queue row refunded
 *
 * This wrapper handles the side-effects that MUST live outside the
 * transaction because they represent human-action signals, not DB state:
 *   - "funds in transit" CRITICAL notification (when in_transit_payouts > 0)
 *   - cancelled-payouts staff notification (best-effort, idempotent)
 *   - refund-processed staff notification (best-effort, idempotent)
 *
 * Errors from the RPC bubble up as generic messages to prevent INFO_LEAKAGE
 * — Stripe will retry the webhook on non-2xx.
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

  // ── Atomic state transition via SECURITY DEFINER RPC ──────────
  const { data, error } = await supabase.rpc('handle_charge_refunded', {
    p_charge_id: charge.id,
    p_payment_intent_id: paymentIntentId,
    p_refund_amount_cents: charge.amount_refunded ?? 0,
    p_currency: charge.currency ?? 'usd',
  })

  if (error) {
    // Mask internals; Stripe retries on non-2xx so re-throw a generic error.
    console.error(`handle_charge_refunded RPC failed for charge=${charge.id}:`, error.message)
    throw new Error('refund_processing_failed')
  }

  const result = (data ?? {}) as {
    ok?: boolean
    reason?: string
    already_processed?: boolean
    transaction_id?: string
    account_id?: string
    account_number?: string | null
    account_user_id?: string | null
    previous_status?: string
    already_terminal?: boolean
    cancelled_payouts?: Array<{ id: string; previous_status: string; amount: number }>
    cancelled_payouts_count?: number
    in_transit_payouts?: Array<{ id: string; amount: number }>
    in_transit_payouts_count?: number
    session_id?: string | null
  }

  if (!result.ok) {
    console.warn(`Refund handler no-op: ${result.reason} (pi=${paymentIntentId})`)
    return
  }

  if (result.already_processed) {
    console.log(`Refund already processed for pi=${paymentIntentId} — skipping notifications`)
    return
  }

  const accountId = result.account_id!
  const accountUserId = result.account_user_id ?? null
  const accountLabel = result.account_number || accountId

  // ── Side-effect 1: cancelled-payouts notification (best-effort) ──
  const cancelled = result.cancelled_payouts ?? []
  if (cancelled.length > 0) {
    const totalCancelled = cancelled.reduce((s, p) => s + Number(p.amount), 0)
    console.log(
      `Refund guard: auto-rejected ${cancelled.length} payout(s) totalling $${totalCancelled.toFixed(2)} ` +
      `for account ${accountId} on charge ${charge.id}`
    )
    const { error: cancelNotifErr } = await supabase.from('staff_notifications').insert({
      notification_type: 'refund_payout_conflict',
      title: `🚨 Refund auto-rejected ${cancelled.length} payout(s)`,
      body: `Account ${accountLabel}: ${cancelled.length} payout(s) totalling $${totalCancelled.toFixed(2)} auto-rejected due to refund on charge ${charge.id}.`,
      data: {
        account_id: accountId,
        charge_id: charge.id,
        cancelled_payouts: cancelled,
        user_id: accountUserId,
      },
      idempotency_key: `refund_payout_cancel:${charge.id}:${accountId}`,
    })
    if (cancelNotifErr && cancelNotifErr.code !== '23505') {
      console.error('Cancel payout notification failed:', cancelNotifErr.message)
    }
  }

  // ── Side-effect 2: CRITICAL funds-in-transit notification ──
  // Fired OUTSIDE the RPC because this is a human-action signal, not a DB state
  // change. Pages ops; manual reconciliation required.
  const inTransit = result.in_transit_payouts ?? []
  if (inTransit.length > 0) {
    const totalAtRisk = inTransit.reduce((s, p) => s + Number(p.amount), 0)
    console.error(
      `CRITICAL: Refund ${charge.id} on account ${accountId} with ${inTransit.length} ` +
      `payment_initiated payout(s). Total at risk: $${totalAtRisk.toFixed(2)}. Manual reconciliation required.`
    )
    await supabase.from('staff_notifications').insert({
      notification_type: 'refund_funds_in_transit',
      title: '🚨🚨 CRITICAL: Refund + funds in transit',
      body: `Account ${accountLabel}: refund on charge ${charge.id} but ${inTransit.length} payout(s) ` +
        `totalling $${totalAtRisk.toFixed(2)} are in payment_initiated state. ` +
        `FUNDS MAY ALREADY BE RELEASED. Manual reconciliation required immediately.`,
      data: {
        account_id: accountId,
        charge_id: charge.id,
        at_risk_payouts: inTransit,
        user_id: accountUserId,
      },
      idempotency_key: `refund_in_transit:${charge.id}:${accountId}`,
    }).catch(() => {})
  }

  // ── Side-effect 3: standard refund-processed notification ──
  const { error: notifErr } = await supabase.from('staff_notifications').insert({
    notification_type: 'refund_processed',
    title: '💸 Refund: Account invalidated',
    body: `Account ${accountLabel} invalidated due to refund on charge ${charge.id}. Previous status: ${result.previous_status}.`,
    data: {
      account_id: accountId,
      charge_id: charge.id,
      payment_intent_id: paymentIntentId,
      previous_status: result.previous_status,
      user_id: accountUserId,
    },
    idempotency_key: `refund:${charge.id}`,
  })
  if (notifErr && notifErr.code !== '23505') {
    console.error('Staff notification insert failed:', notifErr.message)
  }

  const newStatus = result.already_terminal ? result.previous_status : 'failed_confirmed'
  console.log(
    `Refund processed: account=${accountId} charge=${charge.id} pi=${paymentIntentId} ` +
    `previous_status=${result.previous_status} new_status=${newStatus} ` +
    `cancelled=${cancelled.length} in_transit=${inTransit.length}`
  )
}
