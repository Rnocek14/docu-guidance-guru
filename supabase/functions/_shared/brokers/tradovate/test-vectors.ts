// Test vectors for Tradovate adapter verification
// These provide known-good inputs for unit tests.

export const TRADOVATE_TEST_SECRET = 'test-tradovate-webhook-secret-32chars!';

/** Valid fill payload */
export const VALID_FILL_PAYLOAD = {
  accountId: 'TV-12345',
  tradeId: 'fill-abc-001',
  timestamp: Date.now(),
  symbol: 'NQZ5',
  side: 'Buy' as const,
  qty: 2,
  price: 18500.25,
  pnl: 150.00,
  commission: 4.18,
  fees: 0.50,
  eventType: 'fill',
};

/** Payload missing required tradeId */
export const MISSING_TRADE_ID_PAYLOAD = {
  accountId: 'TV-12345',
  // tradeId missing
  timestamp: Date.now(),
  symbol: 'ESM24',
  side: 'Sell' as const,
  qty: 1,
  price: 5200.00,
};

/** Payload with invalid side */
export const INVALID_SIDE_PAYLOAD = {
  accountId: 'TV-12345',
  tradeId: 'fill-xyz-002',
  timestamp: Date.now(),
  symbol: 'CLZ5',
  side: 'LONG', // invalid
  qty: 3,
};

/** Payload with zero qty */
export const ZERO_QTY_PAYLOAD = {
  accountId: 'TV-12345',
  tradeId: 'fill-xyz-003',
  timestamp: Date.now(),
  symbol: 'GCG25',
  side: 'Buy' as const,
  qty: 0, // invalid: must be positive
};

/** Payload with cancel event type */
export const CANCEL_PAYLOAD = {
  accountId: 'TV-12345',
  tradeId: 'fill-cancel-004',
  timestamp: Date.now(),
  symbol: 'MESH24',
  side: 'Sell' as const,
  qty: 1,
  price: 5100.00,
  eventType: 'cancel',
};

/**
 * Generate a valid HMAC signature for a test payload.
 * Uses Web Crypto API (works in Deno).
 */
export async function generateTestSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
