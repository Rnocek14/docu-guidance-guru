import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

// No CORS needed — called by Stripe servers, not browsers
// verify_jwt = false — we verify Stripe's webhook signature instead

// ============================================================
// Tier → Cohort mapping
// Maps the tierId stored in checkout metadata to the correct
// cohort in the database for account creation.
// ============================================================
const TIER_COHORT_MAP: Record<string, {
  accountSize: number
  cohortName: string
}> = {
  starter: { accountSize: 50_000, cohortName: 'Starter' },
  pro: { accountSize: 100_000, cohortName: 'Pro' },
  elite: { accountSize: 200_000, cohortName: 'Elite' },
}

/**
 * Generate a unique account number: EVAL-YYYYMMDD-XXXXX
 */
function generateAccountNumber(): string {
  const date = new Date()
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `EVAL-${ymd}-${rand}`
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: '2025-08-27.basil',
  })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured')
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // ── 1. Verify Stripe signature ───────────────────────────
    const rawBody = await req.text()
    const signature = req.headers.get('stripe-signature')

    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing stripe-signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret)
    } catch (err) {
      console.error('Webhook signature verification failed:', (err as Error).message)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Stripe webhook: type=${event.type} id=${event.id}`)

    // ── 2. Handle events ────────────────────────────────────
    switch (event.type) {
      case 'checkout.session.completed': {
        await handleCheckoutCompleted(supabase, event.data.object as Stripe.Checkout.Session)
        break
      }
      case 'charge.refunded': {
        await handleChargeRefunded(supabase, stripe, event.data.object as Stripe.Charge)
        break
      }
      default: {
        console.log(`Unhandled event type: ${event.type}`)
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('Stripe webhook handler error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

// ================================================================
// checkout.session.completed
// Creates evaluation account + rule snapshot atomically
// ================================================================
async function handleCheckoutCompleted(
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

  // Look up the cohort by name + is_active + intake_active
  const { data: cohort, error: cohortError } = await supabase
    .from('cohorts')
    .select('*')
    .eq('name', tierConfig.cohortName)
    .eq('is_active', true)
    .eq('intake_active', true)
    .limit(1)
    .maybeSingle()

  if (cohortError || !cohort) {
    console.error('Cohort lookup failed', {
      cohortName: tierConfig.cohortName,
      error: cohortError?.message,
    })
    return
  }

  // Build rule snapshot from cohort (dispute-readiness: this is what was in effect at purchase)
  const ruleSnapshot = {
    cohort_id: cohort.id,
    cohort_name: cohort.name,
    cohort_version: cohort.version,
    max_daily_loss_percent: cohort.max_daily_loss_percent,
    max_total_drawdown_percent: cohort.max_total_drawdown_percent,
    profit_target_percent: cohort.profit_target_percent,
    min_trading_days: cohort.min_trading_days,
    max_position_size_percent: cohort.max_position_size_percent,
    payout_split_percent: cohort.payout_split_percent,
    max_payout_percent: cohort.max_payout_percent,
    max_payout_absolute: cohort.max_payout_absolute,
    payout_cooldown_days: cohort.payout_cooldown_days,
    min_trading_days_between_payouts: cohort.min_trading_days_between_payouts,
    payout_eligibility_delay_days: cohort.payout_eligibility_delay_days,
    first_payout_cap_amount: cohort.first_payout_cap_amount,
    lifetime_cap_multiple: cohort.lifetime_cap_multiple,
    entry_fee: cohort.entry_fee,
    // Dispute-readiness fields
    stripe_session_id: session.id,
    stripe_payment_intent: session.payment_intent,
    disclaimer_version: metadata.disclaimer_version || 'v1',
    product_description: metadata.product_description || 'Simulated trading evaluation access',
    purchased_at: new Date().toISOString(),
  }

  const accountNumber = generateAccountNumber()

  // Create the account
  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      cohort_id: cohort.id,
      account_number: accountNumber,
      starting_balance: tierConfig.accountSize,
      current_balance: tierConfig.accountSize,
      highest_balance: tierConfig.accountSize,
      payout_cycle_start_balance: tierConfig.accountSize,
      rule_snapshot: ruleSnapshot,
      status: 'active',
    })
    .select('id')
    .single()

  if (accountError) {
    console.error('Account creation failed:', accountError.message)
    return
  }

  // Record payment transaction for audit trail
  await supabase.from('payment_transactions').insert({
    user_id: userId,
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || 'usd',
    direction: 'inbound',
    purpose: 'evaluation_purchase',
    provider: 'stripe',
    provider_payment_id: session.payment_intent as string,
    status: 'completed',
    idempotency_key: `stripe:checkout:${session.id}`,
    metadata: {
      tier_id: tierId,
      account_id: account.id,
      account_number: accountNumber,
      stripe_session_id: session.id,
    },
  })

  console.log(`Account created: id=${account.id} number=${accountNumber} tier=${tierId} user=${userId}`)
}

// ================================================================
// charge.refunded
// Invalidate account(s) linked to the refunded payment
// ================================================================
async function handleChargeRefunded(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe,
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

  console.log(`Account ${accountId} invalidated due to refund on pi=${paymentIntentId}`)
}
