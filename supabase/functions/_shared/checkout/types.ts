// ============================================================
// Provider-agnostic checkout types
// Any payment processor must conform to this interface.
// ============================================================

export interface CheckoutTierConfig {
  tierId: string
  name: string
  accountSize: number
  entryFee: number
  isLive: boolean
}

export interface CreateCheckoutRequest {
  tier: CheckoutTierConfig
  userId: string
  userEmail: string | null
  metadata: CheckoutMetadata
  appOrigin: string
}

export interface CheckoutMetadata {
  disclaimerAccepted: boolean
  disclaimerVersion: string
  rulesAcknowledged: boolean
  rulesAcknowledgedAt: string
  rulesVersion: string
  productDescription: string
}

export interface CreateCheckoutResult {
  provider: string
  checkoutUrl: string
  sessionId: string
  paymentIntent?: string | null
}

export interface CheckoutWebhookEvent {
  provider: string
  eventType: 'checkout_completed' | 'charge_refunded' | 'unknown'
  sessionId: string
  paymentIntent: string | null
  amountCents: number
  currency: string
  metadata: Record<string, string>
}

/**
 * Each payment processor implements this interface.
 * Stripe, Paddle, Lemon Squeezy, etc. all conform to this contract.
 */
export interface CheckoutProviderAdapter {
  providerId: string

  /** Create a checkout session and return a redirect URL. */
  createSession(req: CreateCheckoutRequest): Promise<CreateCheckoutResult>

  /**
   * Verify and parse an incoming webhook request.
   * Returns null if signature is invalid.
   */
  parseWebhook(req: Request): Promise<CheckoutWebhookEvent | null>
}
