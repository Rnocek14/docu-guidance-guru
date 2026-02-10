// Tradovate-specific BrokerAdapter implementation

import type { BrokerAdapter } from '../adapter.ts';
import type { BrokerWebhookContext, AdapterVerifyResult, AdapterParseResult, CanonicalTrade } from '../types.ts';
import { TradovateFillPayload, normalizeSide, parseTimestamp } from './schema.ts';
import { normalizeSymbol } from '../normalize-symbol.ts';

// ── Crypto helpers (Deno Web Crypto API) ──

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time comparison of two hex strings.
 * Compares decoded bytes to avoid timing leaks from string operations.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower.length !== bLower.length || aLower.length % 2 !== 0) return false;

  // Decode hex to bytes and compare
  let result = 0;
  for (let i = 0; i < aLower.length; i += 2) {
    const byteA = parseInt(aLower.substring(i, i + 2), 16);
    const byteB = parseInt(bLower.substring(i, i + 2), 16);
    result |= byteA ^ byteB;
  }
  return result === 0;
}

// ── Replay window ──
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FUTURE_SKEW_MS = 30 * 1000;    // 30 seconds max future tolerance

// ── Adapter ──

export const TradovateAdapter: BrokerAdapter = {
  id: 'tradovate',

  async verify(
    req: Request,
    rawBody: string,
    _ctx: BrokerWebhookContext
  ): Promise<AdapterVerifyResult> {
    const secret = Deno.env.get('TRADOVATE_WEBHOOK_SECRET');
    if (!secret) {
      return { ok: false, decision: 'ERROR', reason: 'TRADOVATE_WEBHOOK_SECRET not configured' };
    }

    // Canonical header pair — single scheme only, no fallbacks
    const ts = req.headers.get('x-tv-timestamp') ?? '';
    const sig = req.headers.get('x-tv-signature') ?? '';

    if (!ts || !sig) {
      return { ok: false, decision: 'REJECTED_SIGNATURE', reason: 'Missing x-tv-timestamp or x-tv-signature header' };
    }

    // Parse timestamp (supports epoch seconds or milliseconds)
    let tsMs: number;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: 'Non-numeric timestamp' };
    }
    // Heuristic: if < 1e12, treat as seconds; otherwise milliseconds
    tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;

    // Directional anti-replay: reject past timestamps beyond window AND future timestamps beyond small skew
    const now = Date.now();
    if (tsMs > now + MAX_FUTURE_SKEW_MS) {
      return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: `Timestamp is in the future (max ${MAX_FUTURE_SKEW_MS / 1000}s future skew allowed)` };
    }
    if (now - tsMs > REPLAY_WINDOW_MS) {
      return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: `Timestamp older than ${REPLAY_WINDOW_MS / 1000}s replay window` };
    }

    // HMAC verification: signature = hmac_sha256(secret, timestamp + "." + rawBody)
    const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
    if (!constantTimeEqual(expected, sig)) {
      return { ok: false, decision: 'REJECTED_SIGNATURE', reason: 'HMAC signature mismatch' };
    }

    return { ok: true, decision: 'ACCEPTED' };
  },

  async parse(
    _req: Request,
    rawBody: string,
    ctx: BrokerWebhookContext
  ): Promise<AdapterParseResult> {
    // JSON parse
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: 'Invalid JSON', schemaOk: false };
    }

    // Schema validation
    const parsed = TradovateFillPayload.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        decision: 'REJECTED_SCHEMA',
        reason: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        schemaOk: false,
      };
    }

    const p = parsed.data;

    // Normalize side (throws on unknown — caught below)
    let side: 'buy' | 'sell';
    try {
      side = normalizeSide(p.side);
    } catch (e) {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: (e as Error).message, schemaOk: false };
    }

    // Normalize symbol
    const symbolRaw = p.symbol;
    const symbolNormalized = normalizeSymbol(symbolRaw);

    // Parse timestamp
    let occurredAt: string;
    try {
      occurredAt = parseTimestamp(p.timestamp);
    } catch (e) {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: (e as Error).message, schemaOk: false };
    }

    // Hash the raw body directly — stable by definition, no re-serialization drift
    const hash = await sha256Hex(rawBody);

    const canonical: CanonicalTrade = {
      broker: 'tradovate',
      externalAccountId: p.accountId,
      externalTradeId: p.tradeId,
      occurredAt,
      receivedAt: ctx.receivedAt,
      symbolRaw,
      symbolNormalized,
      assetClass: 'futures', // Tradovate is futures-only
      side,
      qty: p.qty,
      price: p.price ?? null,
      commission: p.commission ?? null,
      fees: p.fees ?? null,
      pnl: p.pnl ?? null,
      eventType: (p.eventType?.toLowerCase() as CanonicalTrade['eventType']) || 'fill',
      raw: payload,
      hash,
    };

    return {
      ok: true,
      decision: 'ACCEPTED',
      canonical,
      schemaOk: true,
      signatureVerified: true,
      replayWindowOk: true,
    };
  },

  getExternalAccountId(payload: unknown): string | null {
    if (payload && typeof payload === 'object' && 'accountId' in payload) {
      return String((payload as Record<string, unknown>).accountId);
    }
    return null;
  },
};
