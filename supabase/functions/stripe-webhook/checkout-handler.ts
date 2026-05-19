import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'
import { TIER_COHORT_MAP } from '../_shared/checkout/config.ts'
import { getActiveProvider } from '../_shared/providers/adapter.ts'
import { provisionAccount } from '../_shared/providers/lifecycle.ts'

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

  // ── Step 1: Ensure queue row exists and advance to 'queued' ──
  // Status-aware: only update rows in 'session_created' state (prevents rewinding fulfilled/failed).
  // Write-once: never overwrite rules_acknowledged_at if already set.
  const { data: updated, error: updateErr } = await supabase
    .from('checkout_fulfillment_queue')
    .update({
      payment_intent: session.payment_intent as string,
      amount_cents: session.amount_total || 0,
      currency: session.currency || 'usd',
      status: 'queued',
      updated_at: new Date().toISOString(),
      // Canonical provider fields
      provider: 'stripe',
      provider_session_id: session.id,
      provider_payment_id: session.payment_intent as string,
    })
    .eq('stripe_session_id', session.id)
    .in('status', ['session_created'])
    .select('id')

  if (updateErr) {
    console.error(`Queue update failed: ${updateErr.message}`, { sessionId: session.id })
  }

  // Fallback: if no row was updated (EF pre-insert failed, or already past session_created),
  // upsert to handle retries safely via the unique index on stripe_session_id.
  if (!updated || updated.length === 0) {
    const { error: upsertErr } = await supabase
      .from('checkout_fulfillment_queue')
      .upsert({
        stripe_session_id: session.id,
        user_id: userId,
        tier_id: tierId,
        payment_intent: session.payment_intent as string,
        amount_cents: session.amount_total || 0,
        currency: session.currency || 'usd',
        status: 'queued',
        rules_acknowledged: metadata.rules_acknowledged === 'true',
        rules_acknowledged_at: metadata.rules_acknowledged_at || null,
        rules_version: metadata.rules_version || 'v1.0',
        // Canonical provider fields
        provider: 'stripe',
        provider_session_id: session.id,
        provider_payment_id: session.payment_intent as string,
        rail_key: 'stripe_card',
      }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })

    if (upsertErr) {
      console.error(`Queue upsert failed: ${upsertErr.message}`, { sessionId: session.id })
      return
    }
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

  // ── Step 2: Claim the queue row atomically (v2 RPC, provider-agnostic) ──
  const { data: claimed, error: claimError } = await supabase
    .rpc('claim_checkout_fulfillment_v2', {
      p_provider: 'stripe',
      p_provider_session_id: session.id,
    })

  if (claimError) {
    console.error(`Claim RPC failed: ${claimError.message}`, { sessionId: session.id })
    return
  }

  const claimRow = Array.isArray(claimed) ? claimed[0] : claimed
  if (!claimRow) {
    console.log(`Checkout not claimable (already fulfilled or processing): session=${session.id}`)
    return
  }

  // ── Step 3: Atomic fulfillment via v2 DB RPC ──
  // Cohort resolution + snapshot + account + txn + queue update all in one transaction.
  const { data: accountId, error: fulfillError } = await supabase
    .rpc('fulfill_checkout_session_v2', {
      p_queue_id: claimRow.id,
      p_user_id: userId,
      p_provider: 'stripe',
      p_provider_session_id: session.id,
      p_provider_payment_id: (session.payment_intent as string) || '',
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

    // Classify: retryable → back to queued; terminal → failed; cap-exhausted → failed_retryable_exhausted.
    // The DB enforces the cap so an edge-function bug can't re-introduce an infinite loop.
    const { data: markResult } = await markQueueError(supabase, claimRow.id, errorMsg, retryable)
    const exhausted = (markResult as { exhausted?: boolean } | null)?.exhausted === true

    console.error(
      `FULFILLMENT_${exhausted ? 'EXHAUSTED' : retryable ? 'BLOCKED' : 'FAILED'}: ${errorMsg}. ` +
      `session=${session.id} user=${userId}. ` +
      `${exhausted ? 'Retry cap reached — marked failed_retryable_exhausted.' : retryable ? 'Queued for retry.' : 'Marked as failed.'}`
    )

    // Staff notification (idempotent per session)
    const notifType = exhausted ? 'intake_retry_exhausted' : retryable ? 'intake_blocked' : 'intake_failed'
    const notifTitle = exhausted
      ? '⛔ Checkout retry cap reached — manual review required'
      : retryable
        ? '🚨 Paid checkout blocked by breaker'
        : '❌ Checkout fulfillment permanently failed'
    await supabase.from('staff_notifications').insert({
      notification_type: notifType,
      title: notifTitle,
      body: `User ${userId} paid for tier ${tierId}. Reason: ${errorMsg}. Session: ${session.id}. ` +
        `${exhausted ? 'Retry cap exhausted — re-queue manually after fixing root cause.' : retryable ? 'Queued for retry.' : 'Requires manual intervention.'}`,
      data: {
        user_id: userId,
        tier_id: tierId,
        stripe_session_id: session.id,
        block_reason: errorMsg,
        queue_id: claimRow.id,
        retryable,
        exhausted,
      },
      idempotency_key: `${notifType}:${session.id}`,
    }).catch(notifErr => {
      console.error('Failed to insert notification:', (notifErr as Error).message)
    })

    return
  }

  console.log(`Account created atomically: id=${accountId} tier=${tierId} user=${userId} session=${session.id}`)

  // ── Step 3b: Affiliate attribution (best-effort, idempotent) ──
  try {
    const { data: queueWithAff } = await supabase
      .from('checkout_fulfillment_queue')
      .select('id, affiliate_code, amount_cents')
      .eq('id', claimRow.id)
      .maybeSingle()
    const affCode = (queueWithAff as { affiliate_code?: string | null } | null)?.affiliate_code
    if (affCode) {
      const amt = (queueWithAff as { amount_cents?: number } | null)?.amount_cents || session.amount_total || 0
      const { error: attribErr } = await supabase.rpc('record_affiliate_attribution', {
        p_source: 'checkout',
        p_source_id: claimRow.id,
        p_code: affCode,
        p_buyer_user_id: userId,
        p_amount_cents: amt,
      })
      if (attribErr) console.error(`Affiliate attribution failed: ${attribErr.message}`, { queueId: claimRow.id })
    }
  } catch (e) {
    console.error('Affiliate attribution threw (non-fatal):', (e as Error).message)
  }

  // ── Step 4: Provision sim account at active provider (best-effort) ──
  // This call is intentionally NON-blocking to checkout completion:
  //   - Trader's payment succeeded and their account row exists.
  //   - If provisioning fails (or no provider is configured), lifecycle.ts
  //     raises a staff_notifications row so ops can manually intervene.
  //   - `external_status` stays NULL until provisioning succeeds, which the
  //     reconciliation pass in daily-risk-snapshot will also surface.
  try {
    const provider = await getActiveProvider()
    if (provider && accountId) {
      const result = await provisionAccount(
        { supabase, requestId: `checkout:${session.id}` },
        provider,
        {
          accountId: accountId as string,
          startingBalance: tierConfig.accountSize,
          tierLabel: tierConfig.cohortName,
          metadata: {
            stripe_session_id: session.id,
            tier_id: tierId,
          },
        }
      )
      if (!result.ok) {
        console.error(
          `Provider provisioning failed: account=${accountId} provider=${provider.id} error=${result.error}`
        )
        // Staff notification — provisioning failure requires manual action
        await supabase.from('staff_notifications').insert({
          notification_type: 'provider_provision_failed',
          title: '🚨 Provider account provisioning failed',
          body: `Account ${accountId} (tier ${tierId}) was created in our DB but the provider (${provider.id}) did not provision a sim account. Error: ${result.error}. MANUAL ACTION REQUIRED — provision the account or refund the trader.`,
          data: {
            account_id: accountId,
            provider: provider.id,
            tier_id: tierId,
            stripe_session_id: session.id,
            error: result.error,
          },
          idempotency_key: `provider_provision_failed:${accountId}`,
        }).catch(() => { /* best-effort */ })
      } else {
        console.log(`Provider provisioned: account=${accountId} provider=${provider.id} external=${result.externalAccountId}`)
      }
    } else if (!provider) {
      console.log(`No active provider configured; skipping provisioning for account=${accountId}`)
    }
  } catch (provErr) {
    // Never fail the checkout because of provisioning issues — log + alert only.
    console.error('Provider provisioning threw:', (provErr as Error).message)
    await supabase.from('staff_notifications').insert({
      notification_type: 'provider_provision_failed',
      title: '🚨 Provider provisioning crashed',
      body: `Account ${accountId} provisioning threw an unexpected error: ${(provErr as Error).message}. MANUAL ACTION REQUIRED.`,
      data: { account_id: accountId, stripe_session_id: session.id },
      idempotency_key: `provider_provision_crashed:${accountId}`,
    }).catch(() => {})
  }
}

/**
 * Mark a queue row with error info via the atomic mark_queue_error_v2 RPC.
 * The DB enforces the retry cap (default 24 ≈ 2 hours at 5-min cron cadence):
 *   - retryable + below cap → 'queued'
 *   - retryable + at/above cap → 'failed_retryable_exhausted' (distinct terminal)
 *   - non-retryable → 'failed'
 * The cap is server-side so an edge-function bug cannot re-create an infinite loop.
 */
async function markQueueError(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  error: string,
  retryable: boolean
) {
  return await supabase.rpc('mark_queue_error_v2', {
    p_queue_id: queueId,
    p_error: error,
    p_retryable: retryable,
    p_cap: 24,
  })
}
