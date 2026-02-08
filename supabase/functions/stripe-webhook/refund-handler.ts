import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

/**
 * Handle charge.refunded:
 * Invalidate account(s) linked to the refunded payment.
 * Also marks any fulfillment queue row as 'refunded'.
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

  // Find the payment transaction to get account_id
  const { data: txn } = await supabase
    .from('payment_transactions')
    .select('id, user_id, metadata')
    .eq('provider', 'stripe')
    .eq('provider_payment_id', paymentIntentId)
    .eq('purpose', 'evaluation_purchase')
    .limit(1)
    .maybeSingle()

  if (!txn) {
    console.error(`No payment transaction found for pi=${paymentIntentId}`)
    return
  }

  const accountId = (txn.metadata as Record<string, unknown>)?.account_id as string
  if (!accountId) {
    console.error(`No account_id in payment transaction metadata, txn=${txn.id}`)
    return
  }

  // Fail the account
  const { error: updateError } = await supabase
    .from('accounts')
    .update({
      status: 'failed',
      failed_at: new Date().toISOString(),
    })
    .eq('id', accountId)

  if (updateError) {
    console.error('Failed to invalidate account on refund:', updateError.message)
    return
  }

  // Update payment transaction status
  await supabase
    .from('payment_transactions')
    .update({ status: 'refunded' })
    .eq('id', txn.id)

  // Mark fulfillment queue row as refunded (if exists)
  const sessionId = (txn.metadata as Record<string, unknown>)?.stripe_session_id as string
  if (sessionId) {
    await supabase
      .from('checkout_fulfillment_queue')
      .update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('stripe_session_id', sessionId)
  }

  console.log(`Account ${accountId} invalidated due to refund on pi=${paymentIntentId}`)
}
