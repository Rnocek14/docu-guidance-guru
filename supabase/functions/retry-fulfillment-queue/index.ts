import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { constantTimeEqual } from '../_shared/crypto.ts'
import { TIER_COHORT_MAP } from '../_shared/checkout/tier-economics.ts'

/**
 * Retry Fulfillment Queue — Cron-triggered Edge Function
 *
 * Picks up checkout_fulfillment_queue rows that were blocked (e.g., by the
 * economic breaker) and retries fulfillment when the breaker clears.
 *
 * Selection criteria:
 *   status = 'queued' AND attempts > 0  (i.e., previously attempted but reverted)
 *
 * Auth: X-Cron-Secret header (same pattern as daily-risk-snapshot)
 * Schedule: Every 5 minutes via pg_cron
 * Batch limit: 10 rows per run to stay within edge function timeouts
 */

const BATCH_LIMIT = 10

function generateAccountNumber(): string {
  const date = new Date()
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `EVAL-${ymd}-${rand}`
}

Deno.serve(async (req) => {
  // Only POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ── Auth: X-Cron-Secret only (no JWT path — this is machine-only) ──
  const incomingSecret = (req.headers.get('X-Cron-Secret') ?? '').trim()

  // Try env var first, fall back to internal_secrets table
  let cronSecret = Deno.env.get('CRON_SECRET')

  if (!cronSecret || cronSecret.length < 16) {
    console.warn('CRON_SECRET env var missing/short — falling back to internal_secrets table')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const tempClient = createClient(supabaseUrl, serviceKey)
    const { data: secretRow } = await tempClient
      .from('internal_secrets')
      .select('value')
      .eq('key', 'CRON_SECRET')
      .single()
    cronSecret = (secretRow?.value ?? '').trim() || null
  }

  if (!cronSecret || cronSecret.length < 16) {
    console.error('CRON_SECRET not configured or too short (both env and DB)')
    return new Response(
      JSON.stringify({ error: 'Service unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!incomingSecret || !(await constantTimeEqual(incomingSecret, cronSecret))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  try {
    // ── Step 1: Find retryable rows ──────────────────────────────
    // Pick anything queued for >60s, regardless of attempts. This covers:
    //   (a) rows blocked by the breaker (attempts > 0), AND
    //   (b) rows that never got their first fulfilment pass because the
    //       webhook crashed before claim/fulfill — without this, paid
    //       traders would never receive an account ("paid but got nothing").
    const staleThreshold = new Date(Date.now() - 60_000).toISOString()
    const { data: rows, error: selectErr } = await supabase
      .from('checkout_fulfillment_queue')
      .select('id, stripe_session_id, user_id, tier_id, payment_intent, amount_cents, currency, attempts')
      .eq('status', 'queued')
      .lt('created_at', staleThreshold)
      .order('created_at', { ascending: true })
      .limit(BATCH_LIMIT)

    if (selectErr) {
      throw new Error(`Queue select failed: ${selectErr.message}`)
    }

    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({ success: true, retried: 0, message: 'No retryable rows' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    console.log(`retry-fulfillment-queue: found ${rows.length} retryable row(s)`)

    const results: Array<{
      session_id: string
      status: 'fulfilled' | 'blocked' | 'failed' | 'skipped'
      error?: string
    }> = []

    // ── Step 2: Process each row ─────────────────────────────────
    for (const row of rows) {
      const tierConfig = TIER_COHORT_MAP[row.tier_id]
      if (!tierConfig) {
        // Terminal: unknown tier — mark as failed via atomic RPC (retryable=false)
        await supabase.rpc('mark_queue_error_v2', {
          p_queue_id: row.id,
          p_error: `Unknown tier_id: ${row.tier_id}`,
          p_retryable: false,
          p_cap: 24,
        })

        results.push({ session_id: row.stripe_session_id, status: 'failed', error: `Unknown tier: ${row.tier_id}` })
        continue
      }

      // Claim atomically (v2 RPC, provider-agnostic)
      const { data: claimed, error: claimErr } = await supabase
        .rpc('claim_checkout_fulfillment_v2', {
          p_provider: 'stripe',
          p_provider_session_id: row.stripe_session_id,
        })

      if (claimErr) {
        console.error(`Claim failed for ${row.stripe_session_id}: ${claimErr.message}`)
        results.push({ session_id: row.stripe_session_id, status: 'skipped', error: claimErr.message })
        continue
      }

      const claimRow = Array.isArray(claimed) ? claimed[0] : claimed
      if (!claimRow) {
        // Already fulfilled, processing, or terminal (incl. failed_retryable_exhausted) — skip
        results.push({ session_id: row.stripe_session_id, status: 'skipped' })
        continue
      }

      // Fulfill atomically (v2 RPC, provider-agnostic)
      const { data: accountId, error: fulfillErr } = await supabase
        .rpc('fulfill_checkout_session_v2', {
          p_queue_id: claimRow.id,
          p_user_id: row.user_id,
          p_provider: 'stripe',
          p_provider_session_id: row.stripe_session_id,
          p_provider_payment_id: row.payment_intent || '',
          p_amount_cents: row.amount_cents || 0,
          p_currency: row.currency || 'usd',
          p_tier_id: row.tier_id,
          p_cohort_name: tierConfig.cohortName,
          p_account_number: generateAccountNumber(),
          p_account_size: tierConfig.accountSize,
          p_disclaimer_version: 'v1',
          p_product_description: 'Simulated trading evaluation access',
        })

      if (fulfillErr) {
        const errorMsg = fulfillErr.message || 'Unknown fulfillment error'
        const isRetryable = isRetryableError(errorMsg)

        // DB-enforced cap: retryable → 'queued' until cap, then 'failed_retryable_exhausted'.
        // Non-retryable → 'failed' immediately.
        const { data: markResult } = await supabase.rpc('mark_queue_error_v2', {
          p_queue_id: claimRow.id,
          p_error: errorMsg,
          p_retryable: isRetryable,
          p_cap: 24,
        })
        const exhausted = (markResult as { exhausted?: boolean } | null)?.exhausted === true

        results.push({
          session_id: row.stripe_session_id,
          status: exhausted ? 'failed' : isRetryable ? 'blocked' : 'failed',
          error: errorMsg,
        })
        continue
      }

      console.log(`Retry fulfilled: session=${row.stripe_session_id} account=${accountId}`)
      results.push({ session_id: row.stripe_session_id, status: 'fulfilled' })
    }

    const fulfilled = results.filter(r => r.status === 'fulfilled').length
    const blocked = results.filter(r => r.status === 'blocked').length
    const failed = results.filter(r => r.status === 'failed').length

    // Staff notification if any fulfilled (so admin knows auto-recovery happened)
    if (fulfilled > 0) {
      await supabase
        .from('staff_notifications')
        .upsert(
          {
            notification_type: 'fulfillment_retry_success',
            title: `✅ Auto-retry fulfilled ${fulfilled} account(s)`,
            body: `${fulfilled} previously-blocked checkout(s) were automatically fulfilled after breaker cleared.`,
            data: { results },
            idempotency_key: `retry_batch:${new Date().toISOString().slice(0, 16)}`, // Per-minute dedup
          },
          { onConflict: 'idempotency_key', ignoreDuplicates: true }
        )
        .catch((err: Error) => console.error('Notification failed:', err.message))
    }

    return new Response(
      JSON.stringify({
        success: true,
        retried: rows.length,
        fulfilled,
        blocked,
        failed,
        skipped: results.filter(r => r.status === 'skipped').length,
        results,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('retry-fulfillment-queue error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// ── Error classification (same patterns as checkout-handler.ts) ──
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

function isRetryableError(err: string): boolean {
  const lower = err.toLowerCase()
  return RETRYABLE_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}
