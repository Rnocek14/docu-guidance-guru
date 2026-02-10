// Tradovate-specific BrokerAdapter implementation

import type { BrokerAdapter } from '../adapter.ts';
import type { BrokerWebhookContext, AdapterVerifyResult, AdapterParseResult, CanonicalTrade } from '../types.ts';
import { TradovoteFillPayload, normalizeSide, parseTimestamp } from './schema.ts';
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Replay window ──
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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

    // Signature headers — configurable names for Tradovate's webhook setup
    const ts = req.headers.get('x-tv-timestamp') ?? req.headers.get('x-webhook-timestamp') ?? '';
    const sig = req.headers.get('x-tv-signature') ?? req.headers.get('x-webhook-signature') ?? '';

    if (!ts || !sig) {
      return { ok: false, decision: 'REJECTED_SIGNATURE', reason: 'Missing signature or timestamp header' };
    }

    // Parse timestamp (supports epoch seconds or milliseconds)
    let tsMs: number;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: 'Non-numeric timestamp' };
    }
    // Heuristic: if < 1e12, treat as seconds; otherwise milliseconds
    tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;

    // Anti-replay: reject timestamps outside window
    const now = Date.now();
    if (Math.abs(now - tsMs) > REPLAY_WINDOW_MS) {
      return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: `Timestamp outside ${REPLAY_WINDOW_MS / 1000}s replay window` };
    }

    // HMAC verification: signature = hmac_sha256(secret, timestamp + "." + rawBody)
    const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
    if (!constantTimeEqual(expected, sig.toLowerCase())) {
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
    const parsed = TradovoteFillPayload.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        decision: 'REJECTED_SCHEMA',
        reason: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        schemaOk: false,
      };
    }

    const p = parsed.data;

    // Normalize
    const symbolRaw = p.symbol;
    const symbolNormalized = normalizeSymbol(symbolRaw);
    let occurredAt: string;
    try {
      occurredAt = parseTimestamp(p.timestamp);
    } catch (e) {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: (e as Error).message, schemaOk: false };
    }

    // Stable hash of raw payload for dedup / audit
    const stableRaw = JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
    const hash = await sha256Hex(stableRaw);

    const canonical: CanonicalTrade = {
      broker: 'tradovate',
      externalAccountId: p.accountId,
      externalTradeId: p.tradeId,
      occurredAt,
      receivedAt: ctx.receivedAt,
      symbolRaw,
      symbolNormalized,
      assetClass: 'futures', // Tradovate is futures-only
      side: normalizeSide(p.side),
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
