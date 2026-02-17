// ============================================================
// Stripe implementation of CheckoutProviderAdapter
// ============================================================

import Stripe from 'https://esm.sh/stripe@18.5.0'
import type {
  CheckoutProviderAdapter,
  CreateCheckoutRequest,
  CreateCheckoutResult,
  CheckoutWebhookEvent,
} from './types.ts'

// Stripe-specific price/product IDs (created in Stripe Dashboard)
const STRIPE_PRICE_MAP: Record<string, { priceId: string; productId: string }> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
  },
}

export class StripeCheckoutAdapter implements CheckoutProviderAdapter {
  readonly providerId = 'stripe'
  private stripe: Stripe
  private webhookSecret: string

  constructor(secretKey: string, webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' })
    this.webhookSecret = webhookSecret
  }

  async createSession(req: CreateCheckoutRequest): Promise<CreateCheckoutResult> {
    const priceConfig = STRIPE_PRICE_MAP[req.tier.tierId]
    if (!priceConfig) {
      throw new Error(`No Stripe price configured for tier: ${req.tier.tierId}`)
    }

    // Reuse existing Stripe customer if possible
    const customers = req.userEmail
      ? await this.stripe.customers.list({ email: req.userEmail, limit: 1 })
      : { data: [] }
    const customerId = customers.data.length > 0 ? customers.data[0].id : undefined

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : (req.userEmail || undefined),
      line_items: [{ price: priceConfig.priceId, quantity: 1 }],
      mode: 'payment',
      metadata: {
        user_id: req.userId,
        tier_id: req.tier.tierId,
        account_size: String(req.tier.accountSize),
        entry_fee: String(req.tier.entryFee),
        disclaimer_accepted: String(req.metadata.disclaimerAccepted),
        disclaimer_version: req.metadata.disclaimerVersion,
        rules_acknowledged: String(req.metadata.rulesAcknowledged),
        rules_acknowledged_at: req.metadata.rulesAcknowledgedAt,
        rules_version: req.metadata.rulesVersion,
        product_description: req.metadata.productDescription,
      },
      payment_intent_data: {
        metadata: {
          user_id: req.userId,
          tier_id: req.tier.tierId,
        },
      },
      success_url: `${req.appOrigin}/trader?session_id={CHECKOUT_SESSION_ID}&payment=success`,
      cancel_url: `${req.appOrigin}/checkout?payment=cancelled`,
    })

    return {
      provider: this.providerId,
      checkoutUrl: session.url!,
      sessionId: session.id,
      paymentIntent: session.payment_intent as string | null,
    }
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<CheckoutWebhookEvent | null> {
    const signature = headers.get('stripe-signature')

    if (!signature) return null

    let event: Stripe.Event
    try {
      event = await this.stripe.webhooks.constructEventAsync(rawBody, signature, this.webhookSecret)
    } catch {
      return null
    }

    // event.id is the canonical Stripe event ID (evt_xxx) — critical for idempotency
    const providerEventId = event.id

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const meta = session.metadata || {}
        return {
          provider: this.providerId,
          eventType: 'checkout_completed',
          providerEventId,
          sessionId: session.id,
          paymentIntent: session.payment_intent as string | null,
          amountCents: session.amount_total || 0,
          currency: session.currency || 'usd',
          metadata: meta as Record<string, string>,
        }
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        return {
          provider: this.providerId,
          eventType: 'charge_refunded',
          providerEventId,
          sessionId: '', // Refunds keyed by payment_intent, not session
          paymentIntent: charge.payment_intent as string | null,
          amountCents: charge.amount_refunded || 0,
          currency: charge.currency || 'usd',
          metadata: {},
        }
      }
      default:
        return {
          provider: this.providerId,
          eventType: 'unknown',
          providerEventId,
          sessionId: '',
          paymentIntent: null,
          amountCents: 0,
          currency: 'usd',
          metadata: {},
        }
    }
  }
}
