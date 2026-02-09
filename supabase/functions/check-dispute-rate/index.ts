import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Chargeback / Dispute Rate Guardrail
 * 
 * Monitors rolling dispute rates against payment processor thresholds.
 * Fires tiered alerts and auto-pauses inbound payments at emergency levels.
 * 
 * Alert thresholds (dispute_rate_percent):
 *   < 0.20%  = ok
 *   >= 0.20% = warn       (internal visibility)
 *   >= 0.30% = high       (Visa VAMP non-compliant territory — investigate)
 *   >= 0.40% = severe     (freeze riskier traffic, add friction)
 *   >= 0.50% = emergency  (auto-pause inbound payments via kill switch)
 * 
 * AUTH: Same model as daily-risk-snapshot:
 *   - Cron: X-Cron-Secret header
 *   - Manual: Admin/Risk JWT
 */

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)).then(buf => new Uint8Array(buf)),
    crypto.subtle.digest('SHA-256', enc.encode(b)).then(buf => new Uint8Array(buf)),
  ])
  if (ah.length !== bh.length) return false
  let diff = 0
  for (let i = 0; i < ah.length; i++) diff |= ah[i] ^ bh[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' } }
    )
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    let cronSecret = Deno.env.get('CRON_SECRET')

    // Fallback: read CRON_SECRET from internal_secrets table if env var missing/short
    if (!cronSecret || cronSecret.length < 16) {
      const tempClient = createClient(supabaseUrl, serviceKey)
      const { data: secretRow } = await tempClient
        .from('internal_secrets')
        .select('value')
        .eq('key', 'CRON_SECRET')
        .single()
      cronSecret = (secretRow?.value ?? '').trim() || null
    }

    // =========================================================================
    // AUTH GATE — identical to daily-risk-snapshot
    // =========================================================================
    let triggeredBy: string = 'unknown'

    const incomingCronSecret = (req.headers.get('X-Cron-Secret') ?? '').trim()
    const authHeader = req.headers.get('Authorization')

    if (incomingCronSecret && authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (incomingCronSecret) {
      if (!cronSecret || cronSecret.length < 16) {
        return new Response(
          JSON.stringify({ error: 'Service unavailable' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (!(await constantTimeEqual(incomingCronSecret, cronSecret))) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      triggeredBy = 'cron'
    } else if (authHeader?.startsWith('Bearer ')) {
      const jwt = authHeader.slice('Bearer '.length).trim()
      if (!jwt || jwt.length > 5000 || jwt.split('.').length !== 3) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      })
      const { data: userData, error: userError } = await anonClient.auth.getUser()
      if (userError || !userData?.user) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      const userId = userData.user.id

      const db = createClient(supabaseUrl, serviceKey)
      const { data: isAdmin } = await db.rpc('has_role', { _user_id: userId, _role: 'admin' })
      const { data: isRisk } = await db.rpc('has_role', { _user_id: userId, _role: 'risk_officer' })
      if (isAdmin !== true && isRisk !== true) {
        return new Response(
          JSON.stringify({ error: 'Forbidden' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      triggeredBy = userId
    } else {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // =========================================================================
    // DISPUTE RATE CHECK
    // =========================================================================
    const db = createClient(supabaseUrl, serviceKey)

    // Get both 30-day and 7-day snapshots
    const [snapshot30Result, snapshot7Result] = await Promise.all([
      db.rpc('get_dispute_rate_snapshot', { window_days: 30 }),
      db.rpc('get_dispute_rate_snapshot', { window_days: 7 }),
    ])

    if (snapshot30Result.error) {
      throw new Error(`Failed to get 30-day dispute snapshot: ${snapshot30Result.error.message}`)
    }
    if (snapshot7Result.error) {
      throw new Error(`Failed to get 7-day dispute snapshot: ${snapshot7Result.error.message}`)
    }

    const snapshot30 = snapshot30Result.data as Record<string, unknown>
    const snapshot7 = snapshot7Result.data as Record<string, unknown>

    const alertLevel30 = snapshot30.alert_level as string
    const alertLevel7 = snapshot7.alert_level as string
    const disputeRate30 = snapshot30.dispute_rate_percent as number
    const disputeRate7 = snapshot7.dispute_rate_percent as number

    // Use the WORSE of the two windows for alerting
    const alertPriority: Record<string, number> = { ok: 0, warn: 1, high: 2, severe: 3, emergency: 4 }
    const effectiveLevel = alertPriority[alertLevel7] > alertPriority[alertLevel30]
      ? alertLevel7
      : alertLevel30
    const effectiveRate = Math.max(disputeRate30, disputeRate7)

    // =========================================================================
    // AUTO-PAUSE: Emergency threshold triggers inbound payment kill switch
    // =========================================================================
    let autoPauseTriggered = false
    if (effectiveLevel === 'emergency') {
      const { data: currentState } = await db
        .from('payment_system_state')
        .select('is_paused_inbound')
        .limit(1)
        .single()

      if (currentState && !currentState.is_paused_inbound) {
        const { error: pauseError } = await db
          .from('payment_system_state')
          .update({
            is_paused_inbound: true,
            pause_reason: `Auto-paused: dispute rate ${effectiveRate.toFixed(2)}% exceeds emergency threshold (0.50%)`,
            paused_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .not('id', 'is', null) // Update all rows (singleton)

        if (pauseError) {
          console.error('Failed to auto-pause inbound payments:', pauseError.message)
        } else {
          autoPauseTriggered = true
          console.log(`🚨 AUTO-PAUSE TRIGGERED: Inbound payments paused at ${effectiveRate.toFixed(2)}% dispute rate`)
        }
      }
    }

    // =========================================================================
    // STAFF NOTIFICATIONS — tiered, deduped
    // =========================================================================
    const today = new Date().toISOString().slice(0, 10)

    if (effectiveLevel !== 'ok') {
      const notificationSeverity: Record<string, string> = {
        warn: '⚠️',
        high: '🔴',
        severe: '🚨',
        emergency: '🚨🚨',
      }

      const notifTitle = autoPauseTriggered
        ? `${notificationSeverity[effectiveLevel]} DISPUTE RATE: Inbound payments AUTO-PAUSED`
        : `${notificationSeverity[effectiveLevel]} Dispute rate: ${effectiveLevel.toUpperCase()}`

      const notifBody = [
        `30-day rate: ${disputeRate30.toFixed(3)}% (${snapshot30.disputes_count}/${snapshot30.payments_count} txns)`,
        `7-day rate: ${disputeRate7.toFixed(3)}% (${snapshot7.disputes_count}/${snapshot7.payments_count} txns)`,
        `Alert level: ${effectiveLevel.toUpperCase()}`,
        `Disputes pending: ${snapshot30.disputes_pending}`,
        autoPauseTriggered ? '⚡ INBOUND PAYMENTS AUTOMATICALLY PAUSED' : '',
        '',
        effectiveLevel === 'high'
          ? 'ACTION: Investigate dispute sources. Consider tightening refund policy.'
          : effectiveLevel === 'severe'
          ? 'ACTION: Add checkout friction. Block high-risk card BINs. Review marketing sources.'
          : effectiveLevel === 'emergency'
          ? 'ACTION: Inbound paused. Review all pending disputes. Contact Stripe if needed.'
          : 'ACTION: Monitor. No immediate action required.',
      ].filter(Boolean).join('\n')

      const idempotencyKey = `dispute_rate:${effectiveLevel}:${today}`

      const { error: notifErr } = await db.from('staff_notifications').insert({
        notification_type: 'dispute_rate_alert',
        title: notifTitle,
        body: notifBody,
        data: {
          snapshot_30d: snapshot30,
          snapshot_7d: snapshot7,
          effective_level: effectiveLevel,
          auto_pause_triggered: autoPauseTriggered,
          triggered_by: triggeredBy,
        },
        idempotency_key: idempotencyKey,
      })

      if (notifErr && notifErr.code !== '23505') {
        console.error('Staff notification insert failed:', notifErr.message)
      }
    }

    // =========================================================================
    // RESPONSE
    // =========================================================================
    const responseBody = JSON.stringify({
      success: true,
      triggered_by: triggeredBy,
      snapshot_30d: snapshot30,
      snapshot_7d: snapshot7,
      effective_alert_level: effectiveLevel,
      auto_pause_triggered: autoPauseTriggered,
    })

    // Self-log to cron_http_runs
    await db.from('cron_http_runs').insert({
      jobname: 'check-dispute-rate',
      http_status: 200,
      http_content: responseBody.slice(0, 2000),
    })

    return new Response(responseBody, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    const error = err as Error
    console.error('Dispute rate check error:', error)

    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const errorDb = createClient(supabaseUrl, serviceKey)
      await errorDb.from('cron_http_runs').insert({
        jobname: 'check-dispute-rate',
        http_status: 500,
        http_content: JSON.stringify({ error: error.message }).slice(0, 2000),
      })
    } catch (logErr) {
      console.error('Failed to self-log error:', logErr)
    }

    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
