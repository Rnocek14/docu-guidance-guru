/**
 * Short-ID generator for public payout share URLs.
 * 8-char base36 string from crypto-random bytes (>2 trillion space).
 */
export function generateShortId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] % 36).toString(36);
  }
  return out;
}

export function publicShareUrl(shortId: string): string {
  if (typeof window === 'undefined') return `/p/${shortId}`;
  return `${window.location.origin}/p/${shortId}`;
}