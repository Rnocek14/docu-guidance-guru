import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

/**
 * Handles checkout.session.completed for reset_bundle purchases.
 *
 * Idempotent end-to-end:
 *   1. Look up the pre-persisted reset_purchases row by provider_session_id.
 *      (create-reset-checkout inserts it as status='pending' before redirecting.)
 *   2. Call apply_reset_from_purchase RPC, which atomically:
 *        - marks the purchase paid + applied_at
 *        - restores the breached account (or banks credits)
 *        - decrements one credit if the account was breached
 *        - writes audit_logs (hash-chained) and account_events rows
 *   3. Safe to replay: the RPC short-circuits when applied_at is already set.
 *
 * If no pending row exists (unlikely race), we self-heal by inserting one from
 * the session metadata so funds are never lost.
 */
export async function handleResetBundleCompleted(
  supabase: ReturnType<typeof createClient>,
  session: Stripe.Checkout.Session,
  eventId: string,
) {
  const md = session.metadata || {}
  const userId = md.user_id
  const accountId = md.account_id
  const bundleId = md.bundle_id

  if (!userId || !accountId || !bundleId) {
    console.error('reset-handler: missing metadata', { sessionId: session.id, eventId })
    return
  }

  // 1. Find the pre-persisted pending purchase row
  const { data: purchase, error: lookupErr } = await supabase
    .from('reset_purchases')
    .select('id, status, applied_at')
    .eq('provider', 'stripe')
    .eq('provider_session_id', session.id)
    .maybeSingle()

  if (lookupErr) {
    console.error(`reset-handler: lookup failed: ${lookupErr.message}`, { sessionId: session.id, eventId })
    return
  }

  let purchaseId = purchase?.id

  // 1b. Self-heal: pre-persist row never landed. Insert from metadata.
  if (!purchaseId) {
    const resetsTotal = Number(md.resets_total ?? 1)
    const amountCents = session.amount_total || 0
    const { data: inserted, error: insertErr } = await supabase
      .from('reset_purchases')
      .insert({
        user_id: userId,
        account_id: accountId,
        bundle_id: bundleId,
        resets_total: resetsTotal,
        resets_remaining: resetsTotal,
        amount_paid_cents: amountCents,
        urgency_window_active: md.urgency_window_active === 'true',
        provider: 'stripe',
        provider_session_id: session.id,
        status: 'pending',
        metadata: { self_healed: true, stripe_event_id: eventId },
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      console.error(`reset-handler: self-heal insert failed: ${insertErr?.message}`, { sessionId: session.id, eventId })
      await supabase.from('staff_notifications').insert({
        notification_type: 'reset_purchase_unrecoverable',
        title: '🚨 Reset purchase could not be recorded',
        body: `Stripe session ${session.id} paid for a reset bundle but DB row could not be created. user=${userId} account=${accountId} bundle=${bundleId}.`,
        data: { session_id: session.id, event_id: eventId, user_id: userId, account_id: accountId, bundle_id: bundleId },
        idempotency_key: `reset_purchase_unrecoverable:${session.id}`,
      }).catch(() => {})
      return
    }
    purchaseId = inserted.id
  }

  // 2. Apply the reset (idempotent inside the RPC)
  const { data: applyResult, error: applyErr } = await supabase.rpc('apply_reset_from_purchase', {
    p_purchase_id: purchaseId,
    p_provider_event_id: eventId,
  })

  if (applyErr) {
    console.error(`reset-handler: apply RPC failed: ${applyErr.message}`, { sessionId: session.id, eventId, purchaseId })
    await supabase.from('staff_notifications').insert({
      notification_type: 'reset_apply_failed',
      title: '🚨 Reset purchase paid but not applied',
      body: `Purchase ${purchaseId} (session ${session.id}) failed to apply: ${applyErr.message}. Manual intervention required.`,
      data: { purchase_id: purchaseId, session_id: session.id, event_id: eventId, error: applyErr.message },
      idempotency_key: `reset_apply_failed:${purchaseId}`,
    }).catch(() => {})
    return
  }

  console.log(`reset-handler: applied purchase=${purchaseId} session=${session.id} result=${JSON.stringify(applyResult)}`)

  // Affiliate attribution (best-effort, idempotent)
  try {
    const { data: prow } = await supabase
      .from('reset_purchases')
      .select('affiliate_code, amount_paid_cents, user_id')
      .eq('id', purchaseId)
      .maybeSingle()
    const affCode = (prow as { affiliate_code?: string | null } | null)?.affiliate_code
    if (affCode) {
      const amt = (prow as { amount_paid_cents?: number } | null)?.amount_paid_cents || session.amount_total || 0
      const buyer = (prow as { user_id?: string } | null)?.user_id || userId
      const { error: attribErr } = await supabase.rpc('record_affiliate_attribution', {
        p_source: 'reset',
        p_source_id: purchaseId,
        p_code: affCode,
        p_buyer_user_id: buyer,
        p_amount_cents: amt,
      })
      if (attribErr) console.error(`Reset affiliate attribution failed: ${attribErr.message}`, { purchaseId })
    }
  } catch (e) {
    console.error('Reset affiliate attribution threw (non-fatal):', (e as Error).message)
  }
}