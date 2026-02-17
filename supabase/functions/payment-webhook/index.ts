import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCheckoutProvider } from '../_shared/checkout/registry.ts'
import type { CheckoutWebhookEvent } from '../_shared/checkout/types.ts'

// ============================================================
// Provider-Agnostic Payment Webhook Router
//
// Single endpoint that detects the payment provider by
// request signature headers and routes to the appropriate adapter.
//
// verify_jwt = false — we verify provider signatures instead
// No CORS — called by provider servers, not browsers
// ============================================================

const PROVIDER_DETECTION: Array<{
  headerKey: string
  railKey: string
}> = [
  { headerKey: 'stripe-signature', railKey: 'stripe_card' },
  // { headerKey: 'paddle-signature', railKey: 'paddle_card' },
  // { headerKey: 'x-lemon-squeezy-signature', railKey: 'lemonsqueezy_card' },
]

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  try {
    // ── 1. Detect provider by signature header ─────────────
    let detectedRailKey: string | null = null
    for (const { headerKey, railKey } of PROVIDER_DETECTION) {
      if (req.headers.get(headerKey)) {
        detectedRailKey = railKey
        break
      }
    }

    if (!detectedRailKey) {
      console.warn('payment-webhook: no recognized provider signature header')
      return new Response(JSON.stringify({ received: true, handled: false, reason: 'unknown_provider' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── 2. Get adapter and verify + parse webhook ──────────
    let adapter
    try {
      adapter = getCheckoutProvider(detectedRailKey)
    } catch (adapterErr) {
      const msg = (adapterErr as Error).message
      console.error(`payment-webhook: adapter init failed for ${detectedRailKey}: ${msg}`)
      await emitErrorNotification(supabase, detectedRailKey, null, `Adapter init failed: ${msg}`)
      return new Response(JSON.stringify({ received: true, error: 'provider_config_error' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const event = await adapter.parseWebhook(req)

    if (!event) {
      console.warn(`payment-webhook: signature verification failed for ${detectedRailKey}`)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Guard: providerEventId MUST be populated for idempotency
    if (!event.providerEventId) {
      console.error(`payment-webhook: adapter returned empty providerEventId for ${detectedRailKey}`)
      await emitErrorNotification(supabase, detectedRailKey, null, 'Adapter returned empty providerEventId — idempotency broken')
      return new Response(JSON.stringify({ received: true, error: 'missing_event_id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`payment-webhook: provider=${event.provider} type=${event.eventType} eventId=${event.providerEventId} session=${event.sessionId}`)

    // ── 3. Route by normalized event type ──────────────────
    switch (event.eventType) {
      case 'checkout_completed': {
        await handleCheckoutCompleted(supabase, event)
        break
      }
      case 'charge_refunded': {
        // Refund handling: log for now. Complex refund logic stays in
        // stripe-webhook until second provider is added, then migrates here.
        console.log(`payment-webhook: charge_refunded for pi=${event.paymentIntent} eventId=${event.providerEventId}`)
        break
      }
      default: {
        console.log(`payment-webhook: unhandled event type: ${event.eventType} (${event.providerEventId})`)
      }
    }

    return new Response(JSON.stringify({ received: true, provider: event.provider, eventType: event.eventType }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('payment-webhook error:', error)
    // Return 200 to prevent provider retry storms, but emit staff notification
    await emitErrorNotification(supabase, 'unknown', null, `Unhandled error: ${error.message}`)
    return new Response(JSON.stringify({ received: true, error: error.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

/**
 * Handle checkout_completed: upsert queue row with canonical provider fields,
 * then trigger fulfillment claim.
 */
async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createClient>,
  event: CheckoutWebhookEvent
) {
  const userId = event.metadata?.user_id
  const tierId = event.metadata?.tier_id

  if (!userId || !tierId) {
    console.error(`payment-webhook: missing user_id or tier_id in metadata, eventId=${event.providerEventId}`)
    await emitErrorNotification(supabase, event.provider, event.providerEventId, `Missing user_id/tier_id in checkout metadata`)
    return
  }

  // Upsert keyed on (provider, provider_session_id) — works for any provider
  // If row was pre-created by create-checkout-session, this updates it to 'queued'.
  // If row doesn't exist (edge case / race), this creates it.
  const { error: upsertErr } = await supabase
    .from('checkout_fulfillment_queue')
    .upsert({
      // Canonical provider-agnostic fields
      provider: event.provider,
      provider_session_id: event.sessionId,
      provider_event_id: event.providerEventId,
      provider_payment_id: event.paymentIntent,
      // Legacy Stripe fields (backward compat)
      stripe_session_id: event.sessionId,
      payment_intent: event.paymentIntent,
      // Core fields
      user_id: userId,
      tier_id: tierId,
      amount_cents: event.amountCents,
      currency: event.currency,
      status: 'queued',
      rules_acknowledged: event.metadata?.rules_acknowledged === 'true',
      rules_acknowledged_at: event.metadata?.rules_acknowledged_at || null,
      rules_version: event.metadata?.rules_version || 'v1.0',
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'provider,provider_session_id',
      ignoreDuplicates: false, // Update if exists
    })

  if (upsertErr) {
    console.error(`payment-webhook: queue upsert failed: ${upsertErr.message}`, { eventId: event.providerEventId })
    await emitErrorNotification(supabase, event.provider, event.providerEventId, `Queue upsert failed: ${upsertErr.message}`)
    return
  }

  // Now read the current state
  const { data: queueRow, error: selectErr } = await supabase
    .from('checkout_fulfillment_queue')
    .select('id, status, fulfilled_account_id')
    .eq('provider', event.provider)
    .eq('provider_session_id', event.sessionId)
    .single()

  if (selectErr || !queueRow) {
    console.error(`payment-webhook: queue row not found after upsert: ${selectErr?.message}`, { eventId: event.providerEventId })
    return
  }

  // Already fulfilled — exit early
  if (queueRow.status === 'fulfilled' && queueRow.fulfilled_account_id) {
    console.log(`payment-webhook: already fulfilled session=${event.sessionId} account=${queueRow.fulfilled_account_id}`)
    return
  }

  // Claim + fulfill via existing RPC (shared with stripe-webhook)
  const { data: claimed, error: claimError } = await supabase
    .rpc('claim_checkout_fulfillment', { p_session_id: event.sessionId })

  if (claimError) {
    console.error(`payment-webhook: claim RPC failed: ${claimError.message}`, { eventId: event.providerEventId })
    return
  }

  const claimRow = Array.isArray(claimed) ? claimed[0] : claimed
  if (!claimRow) {
    console.log(`payment-webhook: not claimable (already processing/fulfilled) session=${event.sessionId}`)
    return
  }

  // Import config for cohort mapping
  const { TIER_COHORT_MAP } = await import('../_shared/checkout/config.ts')
  const tierConfig = TIER_COHORT_MAP[tierId]
  if (!tierConfig) {
    console.error(`payment-webhook: unknown tier_id=${tierId}`, { eventId: event.providerEventId })
    return
  }

  const accountNumber = generateAccountNumber()

  const { data: accountId, error: fulfillError } = await supabase
    .rpc('fulfill_checkout_session', {
      p_queue_id: claimRow.id,
      p_user_id: userId,
      p_stripe_session_id: event.sessionId,
      p_payment_intent: event.paymentIntent || '',
      p_amount_cents: event.amountCents,
      p_currency: event.currency,
      p_tier_id: tierId,
      p_cohort_name: tierConfig.cohortName,
      p_account_number: accountNumber,
      p_account_size: tierConfig.accountSize,
      p_disclaimer_version: event.metadata?.disclaimer_version || 'v1',
      p_product_description: event.metadata?.product_description || 'Simulated trading evaluation access',
    })

  if (fulfillError) {
    const errorMsg = fulfillError.message || 'Unknown fulfillment error'
    console.error(`payment-webhook: fulfillment failed: ${errorMsg}`, { eventId: event.providerEventId })

    // Revert to queued for retryable, failed for terminal
    const retryable = isRetryable(errorMsg)
    await supabase
      .from('checkout_fulfillment_queue')
      .update({
        status: retryable ? 'queued' : 'failed',
        last_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimRow.id)

    await emitErrorNotification(
      supabase, event.provider, event.providerEventId,
      `Fulfillment ${retryable ? 'blocked' : 'failed'}: ${errorMsg}. User=${userId} Tier=${tierId}`
    )
    return
  }

  console.log(`payment-webhook: fulfilled session=${event.sessionId} account=${accountId} provider=${event.provider}`)
}

function generateAccountNumber(): string {
  const date = new Date()
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `EVAL-${ymd}-${rand}`
}

const RETRYABLE_PATTERNS = [
  'EVALUATIONS_FROZEN', 'BREAKER', 'timeout', 'rate limit',
  'deadlock', 'could not serialize', 'connection', 'too many connections', 'statement timeout',
]

function isRetryable(err: string): boolean {
  const lower = err.toLowerCase()
  return RETRYABLE_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

/**
 * Emit a staff notification on any internal error path.
 * Idempotent per provider + eventId to prevent notification storms.
 */
async function emitErrorNotification(
  supabase: ReturnType<typeof createClient>,
  provider: string,
  providerEventId: string | null,
  errorDetail: string
) {
  const idempotencyKey = `payment_webhook_error:${provider}:${providerEventId || 'no_event_id'}`
  try {
    await supabase.from('staff_notifications').insert({
      notification_type: 'payment_webhook_error',
      title: `🚨 Payment webhook error (${provider})`,
      body: errorDetail.slice(0, 500),
      data: { provider, provider_event_id: providerEventId, error: errorDetail },
      idempotency_key: idempotencyKey,
    })
  } catch {
    // Best-effort — don't let notification failure break the webhook
  }
}
