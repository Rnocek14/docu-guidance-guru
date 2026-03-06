import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// No CORS needed — this endpoint is called by Wise servers, not browsers
// verify_jwt = false in config.toml — we verify Wise's RSA signature instead

// ============================================================
// Wise Production Public Key (from docs.wise.com)
// Used to verify X-Signature-SHA256 header on incoming webhooks
// ============================================================
const WISE_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Etqd23gYrHGnyo9XnBPt
iMebME5B2N+b3bwIYnb4gMtHoxIFCMJjAy3AMHRRjNaJyFaFbcYHBFhgFwBmVdAn
SjdalBaFMH/ywAiCNcKY7XOSLNA0XBbhTKNSMqjp/ChO6IZxUaxWGIMmJjKzw8VE
+sRO0cXFyu1WoQbcBq2BaV8aG3M+5DRHJ7PfByOvz3JdxVJIKlxJiF7Y26m4qRm
HnJxUXfm2uK/xK3GaqlFo55VJxGVgv2pPxLCBA/ot6dVibG3eHpn2wx3CKs1bj1h
ToT1+p4kcMoHXA7kA+VBLUpEsVwIDAQAB
-----END PUBLIC KEY-----`

const WISE_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7yqTxvpIQLKTNTkL
4C0aDLnBWpQouPJ2VSkDoKelOkJmjS28yPe95fFH83VO3NrGMbqpLIPKoD3xBRFN
g5VAfiJSWozBU4OmfSWF0e7yFdyuis2cp8BEH1OL3NFLBIW2S3hR6fKFcbz91bU9
eA0UkrTPTnfp7zd1vIBfjzNIm62sNRqr3K6KFZ6A2XGmHfOcbSPTHbGlXqjGHcHi
KHo0Nif7ccCpsMpYkfBCfCXqFRkFr+UIkmjezGMRkz/MqyAyVJfAa9aBzODq5cYn
dQIDAQAB
-----END PUBLIC KEY-----`

// ============================================================
// Provider: Wise
// Event types we handle:
//   transfers#state-change → check current_state
//     - outgoing_payment_sent → confirm_payout_payment
//     - cancelled / bounced_back / charged_back / funds_refunded → fail_payout_payment
//   transfers#payout-failure → fail_payout_payment
//
// Payout ID correlation:
//   When creating a Wise transfer via API, set:
//     details.reference = payout_id (our internal UUID)
//   This is returned in webhook payload as data.resource.id (transfer ID)
//   We look up payout_id from transfer metadata stored during initiation
//
// Idempotency:
//   X-Delivery-Id header = unique per delivery attempt
//   data.resource.id + data.current_state = stable event identity
//   We use X-Delivery-Id as provider_event_id for dedup
// ============================================================

interface WiseWebhookPayload {
  data: {
    resource: {
      id: number        // Wise transfer ID
      profile_id: number
      account_id: number
      type: string      // 'transfer'
    }
    current_state: string  // 'outgoing_payment_sent', 'cancelled', etc.
    previous_state: string
    occurred_at: string    // ISO timestamp
  }
  subscription_id: string
  event_type: string       // 'transfers#state-change' or 'transfers#payout-failure'
  schema_version: string
  sent_at: string
}

// States that mean "money arrived"
const CONFIRM_STATES = new Set([
  'outgoing_payment_sent',
])

// States that mean "payment failed"
const FAIL_STATES = new Set([
  'cancelled',
  'bounced_back',
  'charged_back',
  'funds_refunded',
])

/**
 * Verify Wise webhook signature using RSA-SHA256
 * Wise signs the raw body with their private key; we verify with their public key
 */
async function verifyWiseSignature(
  rawBody: string,
  signatureBase64: string,
  isSandbox: boolean
): Promise<boolean> {
  try {
    const publicKeyPem = isSandbox ? WISE_SANDBOX_PUBLIC_KEY : WISE_PRODUCTION_PUBLIC_KEY

    // Import the PEM public key
    const pemHeader = '-----BEGIN PUBLIC KEY-----'
    const pemFooter = '-----END PUBLIC KEY-----'
    const pemContents = publicKeyPem
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\s/g, '')

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))

    const cryptoKey = await crypto.subtle.importKey(
      'spki',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )

    // Decode signature from base64
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0))

    // Encode body as UTF-8
    const bodyBytes = new TextEncoder().encode(rawBody)

    // Verify
    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      bodyBytes
    )

    return isValid
  } catch (err) {
    console.error('Signature verification error:', err)
    return false
  }
}

/**
 * Look up our internal payout_id from the Wise transfer ID
 * During initiate_payout_payment, we store the Wise transfer ID in payout_payments.provider_payment_id
 * OR in payout metadata. We check payout_payments first.
 */
async function lookupPayoutId(
  supabase: ReturnType<typeof createClient>,
  wiseTransferId: string
): Promise<string | null> {
  // Strategy 1: Look up by provider_payment_id in payout_payments
  const { data: payment } = await supabase
    .from('payout_payments')
    .select('payout_id')
    .eq('provider', 'wise')
    .eq('provider_payment_id', wiseTransferId)
    .limit(1)
    .maybeSingle()

  if (payment?.payout_id) return payment.payout_id

  // Strategy 2: Look up by payment_reference pattern in payouts
  // (fallback if transfer was created outside our system)
  const { data: payout } = await supabase
    .from('payouts')
    .select('id')
    .eq('payment_reference', `wise:${wiseTransferId}`)
    .limit(1)
    .maybeSingle()

  return payout?.id || null
}

Deno.serve(async (req) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Determine environment
  const wiseEnvironment = Deno.env.get('WISE_ENVIRONMENT') || 'production'
  const isSandbox = wiseEnvironment === 'sandbox'

  try {
    // Read raw body ONCE (needed for signature verification)
    const rawBody = await req.text()

    // ========================================
    // 1. SIGNATURE VERIFICATION
    // ========================================
    const signatureHeader = req.headers.get('X-Signature-SHA256')
    if (!signatureHeader) {
      console.error('Missing X-Signature-SHA256 header')
      return new Response(
        JSON.stringify({ error: 'Missing signature' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const isValid = await verifyWiseSignature(rawBody, signatureHeader, isSandbox)
    if (!isValid) {
      console.error('Invalid Wise webhook signature')
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // ========================================
    // 2. PARSE PAYLOAD
    // ========================================
    const payload: WiseWebhookPayload = JSON.parse(rawBody)
    const deliveryId = req.headers.get('X-Delivery-Id')
    const isTestNotification = req.headers.get('X-Test-Notification') === 'true'

    // Handle test notifications (Wise sends these during subscription setup)
    if (isTestNotification) {
      console.log('Received Wise test notification, acknowledging')
      return new Response(
        JSON.stringify({ success: true, test: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Validate event type
    if (!['transfers#state-change', 'transfers#payout-failure'].includes(payload.event_type)) {
      // Not a transfer event we care about — acknowledge silently
      console.log(`Ignoring event type: ${payload.event_type}`)
      return new Response(
        JSON.stringify({ success: true, ignored: true, event_type: payload.event_type }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // ========================================
    // 3. EXTRACT FIELDS
    // ========================================
    const wiseTransferId = String(payload.data.resource.id)
    const currentState = payload.data.current_state
    const occurredAt = payload.data.occurred_at || new Date().toISOString()

    // Use X-Delivery-Id as provider_event_id (unique per delivery)
    // Fallback to deterministic key from transfer + state
    const providerEventId = deliveryId || `wise:${wiseTransferId}:${currentState}:${payload.sent_at}`

    console.log(`Wise webhook: transfer=${wiseTransferId} state=${currentState} delivery=${deliveryId}`)

    // ========================================
    // 4. DETERMINE ACTION
    // ========================================
    const isConfirm = CONFIRM_STATES.has(currentState)
    const isFail = FAIL_STATES.has(currentState) || payload.event_type === 'transfers#payout-failure'

    if (!isConfirm && !isFail) {
      // Intermediate state (processing, funds_converted, etc.) — acknowledge but don't act
      console.log(`Wise intermediate state: ${currentState}, acknowledging`)
      return new Response(
        JSON.stringify({ success: true, state: currentState, action: 'none' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // ========================================
    // 5. LOOK UP PAYOUT ID
    // ========================================
    const payoutId = await lookupPayoutId(supabase, wiseTransferId)

    if (!payoutId) {
      console.error(`No payout found for Wise transfer ${wiseTransferId}`)
      // Return 200 to prevent Wise from retrying (we can't process this)
      // But log it for manual reconciliation
      return new Response(
        JSON.stringify({
          success: false,
          error: 'payout_not_found',
          wise_transfer_id: wiseTransferId,
          hint: 'No matching payout found. Check if transfer was created outside the system.'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // ========================================
    // 6. CALL CONFIRM OR FAIL RPC
    // ========================================
    if (isConfirm) {
      const { data: result, error } = await supabase.rpc('confirm_payout_payment', {
        _payout_id: payoutId,
        _provider: 'wise',
        _provider_payment_id: wiseTransferId,
        _provider_event_id: providerEventId,
        _raw_webhook: payload as unknown as Record<string, unknown>,
        _confirmed_at: occurredAt,
      })

      if (error) {
        console.error('confirm_payout_payment RPC error:', error)
        // Return 500 so Wise retries
        return new Response(
          JSON.stringify({ error: 'Internal error processing confirmation' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
      }

      console.log(`Wise confirm result: payout=${payoutId}`, JSON.stringify(result))

      // If event_id_conflict, return 200 (don't retry) but flag it
      if (result && !result.success && result.error === 'event_id_conflict') {
        console.error(`EVENT_ID_CONFLICT: provider_event_id=${providerEventId} claimed_payout=${payoutId} actual_payout=${result.existing_payout_id}`)
        return new Response(
          JSON.stringify(result),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          action: 'confirmed',
          payout_id: payoutId,
          wise_transfer_id: wiseTransferId,
          duplicate: result?.duplicate || false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (isFail) {
      // Map Wise states to failure codes
      const failureCodes: Record<string, string> = {
        cancelled: 'transfer_cancelled',
        bounced_back: 'recipient_bank_returned',
        charged_back: 'charged_back',
        funds_refunded: 'funds_refunded',
      }

      const failureReasons: Record<string, string> = {
        cancelled: 'Wise transfer was cancelled',
        bounced_back: 'Payment bounced back from recipient bank',
        charged_back: 'Transfer was charged back',
        funds_refunded: 'Funds were refunded to sender',
      }

      const failureCode = failureCodes[currentState] || `wise_${currentState}`
      const failureReason = failureReasons[currentState] || `Wise transfer entered state: ${currentState}`

      const { data: result, error } = await supabase.rpc('fail_payout_payment', {
        _payout_id: payoutId,
        _provider: 'wise',
        _provider_payment_id: wiseTransferId,
        _provider_event_id: providerEventId,
        _failure_code: failureCode,
        _failure_reason: failureReason,
        _raw_webhook: payload as unknown as Record<string, unknown>,
      })

      if (error) {
        console.error('fail_payout_payment RPC error:', error)
        return new Response(
          JSON.stringify({ error: 'Internal error processing failure' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
      }

      console.log(`Wise fail result: payout=${payoutId}`, JSON.stringify(result))

      // Handle event_id_conflict same as confirm path
      if (result && !result.success && result.error === 'event_id_conflict') {
        console.error(`EVENT_ID_CONFLICT: provider_event_id=${providerEventId} claimed_payout=${payoutId} actual_payout=${result.existing_payout_id}`)
        return new Response(
          JSON.stringify(result),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          action: 'failed',
          payout_id: payoutId,
          wise_transfer_id: wiseTransferId,
          failure_code: failureCode,
          payout_reverted_to: result?.payout_reverted_to || 'approved',
          duplicate: result?.duplicate || false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Should never reach here
    return new Response(
      JSON.stringify({ error: 'Unexpected state' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Webhook handler error:', error)
    // Return 500 so Wise retries (could be transient)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
