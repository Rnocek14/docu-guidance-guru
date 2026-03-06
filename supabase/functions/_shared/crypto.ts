// ============================================================
// Shared cryptographic utilities for edge functions.
// Import from here instead of duplicating in each function.
// ============================================================

/**
 * Constant-time string comparison via SHA-256 digest.
 * Prevents timing side-channels on secret comparisons.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const aArr = new Uint8Array(ah)
  const bArr = new Uint8Array(bh)
  if (aArr.length !== bArr.length) return false
  let diff = 0
  for (let i = 0; i < aArr.length; i++) {
    diff |= aArr[i] ^ bArr[i]
  }
  return diff === 0
}

/**
 * Generate a deterministic idempotency key from an input string via SHA-256.
 * Returns a hex-encoded hash suitable for database idempotency columns.
 */
export async function generateDeterministicKey(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  // First 48 chars — matches existing payout-actions / review-actions contract.
  // Do NOT change this length without migrating all idempotency_key columns.
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48)
}
