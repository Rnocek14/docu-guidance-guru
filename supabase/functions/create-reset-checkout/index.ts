// Reset checkout — creates a Stripe Checkout session for a reset bundle.
// Mirrors create-checkout-session's auth/validation patterns but uses a
// single SKU (the reset bundle) and price_data (no Stripe product lookup).
//
// Note: reset application (status transitions, balance restore, bundle
// consumption) happens server-side via the existing payment-webhook /
// reset evaluation flow. This function only opens the payment session and
// pre-persists a `pending` reset_purchases row for idempotency.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'
import { RESET_BUNDLES, URGENCY_WINDOW_MS, type ResetBundleId } from '../_shared/reset-bundles.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData?.user) return json({ error: 'Invalid or expired token' }, 401)
    const user = userData.user

    const body = await req.json().catch(() => ({}))
    const accountId = body?.accountId as string | undefined
    const bundleId = body?.bundleId as ResetBundleId | undefined
    const affiliateCodeRaw = body?.affiliateCode as string | undefined
    const affiliateCode = (() => {
      if (!affiliateCodeRaw) return null
      const c = String(affiliateCodeRaw).trim().toUpperCase()
      return /^[A-Z0-9_-]{3,32}$/.test(c) ? c : null
    })()

    if (!accountId || !bundleId || !RESET_BUNDLES[bundleId]) {
      return json({ error: 'Invalid request' }, 400)
    }
    const bundle = RESET_BUNDLES[bundleId]

    // Verify account ownership
    const { data: account, error: acctErr } = await supabase
      .from('accounts')
      .select('id, user_id, account_number, status')
      .eq('id', accountId)
      .eq('user_id', user.id)
      .single()
    if (acctErr || !account) return json({ error: 'Account not found' }, 404)

    // Urgency gate: only allow urgency_single when most recent violation is <24h old
    let urgencyActive = false
    if (bundle.urgencyOnly) {
      const { data: lastViolation } = await supabase
        .from('violations')
        .select('detected_at')
        .eq('account_id', accountId)
        .order('detected_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (lastViolation?.detected_at) {
        urgencyActive = Date.now() - new Date(lastViolation.detected_at).getTime() < URGENCY_WINDOW_MS
      }
      if (!urgencyActive) return json({ error: 'Urgency window has closed' }, 400)
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) return json({ error: 'Payment provider not configured' }, 500)
    const stripe = new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' })

    // Reuse customer if exists
    const customers = user.email
      ? await stripe.customers.list({ email: user.email, limit: 1 })
      : { data: [] as Array<{ id: string }> }
    const customerId = customers.data[0]?.id

    const origin = req.headers.get('origin') ?? ''
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      customer_email: customerId ? undefined : user.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: bundle.priceUsd * 100,
            product_data: {
              name: `${bundle.label} — Account #${account.account_number}`,
              description: `${bundle.resetCount} reset${bundle.resetCount > 1 ? 's' : ''} for your trading account`,
            },
          },
        },
      ],
      metadata: {
        purchase_type: 'reset_bundle',
        user_id: user.id,
        account_id: accountId,
        bundle_id: bundleId,
        urgency_window_active: String(urgencyActive),
      },
      success_url: `${origin}/trader/accounts/${accountId}?reset=success`,
      cancel_url: `${origin}/reset/${accountId}?bundle=${bundleId}&canceled=1`,
    })

    // Pre-persist pending row (service-role) so webhook can find it idempotently
    const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await serviceClient.from('reset_purchases').insert({
      user_id: user.id,
      account_id: accountId,
      bundle_id: bundleId,
      resets_total: bundle.resetCount,
      resets_remaining: bundle.resetCount,
      amount_paid_cents: bundle.priceUsd * 100,
      urgency_window_active: urgencyActive,
      provider: 'stripe',
      provider_session_id: session.id,
      status: 'pending',
      metadata: { stripe_url: session.url },
      affiliate_code: affiliateCode,
    })

    return json({ url: session.url, sessionId: session.id })
  } catch (err) {
    console.error('create-reset-checkout error:', err)
    return json({ error: 'Failed to start reset checkout' }, 500)
  }
})
