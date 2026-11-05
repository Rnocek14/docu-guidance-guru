// WealthCharts BrokerAdapter — inbound fill webhooks (Meridian contract v1).
//
// Signature: x-wl-signature = hex(hmac_sha256(WEALTHCHARTS_WEBHOOK_SECRET,
//            x-wl-timestamp + "." + rawBody))
// Anti-replay: 5 min past window, 30 s future skew.
// Fail-closed: missing secret => ERROR, never accepted.

import type { BrokerAdapter } from '../adapter.ts';
import type { BrokerWebhookContext, AdapterVerifyResult, AdapterParseResult, CanonicalTrade } from '../types.ts';
import { WealthChartsFillPayload, normalizeSide, parseTimestamp } from './schema.ts';
import { normalizeSymbol } from '../normalize-symbol.ts';

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const HEX_RE = /^[0-9a-f]+$/;
function constantTimeEqual(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x.length !== y.length || x.length === 0 || x.length % 2 !== 0) return false;
  if (!HEX_RE.test(x) || !HEX_RE.test(y)) return false;
  let r = 0;
  for (let i = 0; i < x.length; i += 2) r |= parseInt(x.slice(i, i + 2), 16) ^ parseInt(y.slice(i, i + 2), 16);
  return r === 0;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

export const WealthChartsAdapter: BrokerAdapter = {
  id: 'wealthcharts',

  async verify(req: Request, rawBody: string, _ctx: BrokerWebhookContext): Promise<AdapterVerifyResult> {
    const secret = Deno.env.get('WEALTHCHARTS_WEBHOOK_SECRET');
    if (!secret) return { ok: false, decision: 'ERROR', reason: 'WEALTHCHARTS_WEBHOOK_SECRET not configured' };

    const ts = req.headers.get('x-wl-timestamp') ?? '';
    const sig = req.headers.get('x-wl-signature') ?? '';
    if (!ts || !sig) return { ok: false, decision: 'REJECTED_SIGNATURE', reason: 'Missing x-wl-timestamp or x-wl-signature header' };

    const n = Number(ts);
    if (!Number.isFinite(n)) return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: 'Non-numeric timestamp' };
    const tsMs = n < 1e12 ? n * 1000 : n;
    const now = Date.now();
    if (tsMs > now + MAX_FUTURE_SKEW_MS) return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: 'Timestamp in the future' };
    if (now - tsMs > REPLAY_WINDOW_MS) return { ok: false, decision: 'REJECTED_TIME_SKEW', reason: 'Timestamp outside replay window' };

    const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
    if (!constantTimeEqual(expected, sig)) return { ok: false, decision: 'REJECTED_SIGNATURE', reason: 'HMAC signature mismatch' };
    return { ok: true, decision: 'ACCEPTED' };
  },

  async parse(_req: Request, rawBody: string, ctx: BrokerWebhookContext): Promise<AdapterParseResult> {
    let payload: unknown;
    try { payload = JSON.parse(rawBody); } catch {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: 'Invalid JSON', schemaOk: false };
    }
    const parsed = WealthChartsFillPayload.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, decision: 'REJECTED_SCHEMA', schemaOk: false,
        reason: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const p = parsed.data;
    let side: 'buy' | 'sell';
    let occurredAt: string;
    try { side = normalizeSide(p.side); occurredAt = parseTimestamp(p.timestamp); } catch (e) {
      return { ok: false, decision: 'REJECTED_SCHEMA', reason: (e as Error).message, schemaOk: false };
    }
    const hash = toHex(await crypto.subtle.digest('SHA-256', enc.encode(rawBody)));

    const canonical: CanonicalTrade = {
      broker: 'wealthcharts',
      externalAccountId: p.account_id,
      externalTradeId: p.fill_id,
      occurredAt,
      receivedAt: ctx.receivedAt,
      symbolRaw: p.symbol,
      symbolNormalized: normalizeSymbol(p.symbol),
      assetClass: 'futures',
      side,
      qty: p.qty,
      price: p.price,
      commission: p.commission ?? null,
      fees: p.fees ?? null,
      pnl: p.realized_pnl ?? null,
      eventType: p.event_type,
      raw: payload,
      hash,
    };
    return { ok: true, decision: 'ACCEPTED', canonical, schemaOk: true, signatureVerified: true, replayWindowOk: true };
  },

  getExternalAccountId(payload: unknown): string | null {
    if (payload && typeof payload === 'object' && 'account_id' in payload) {
      return String((payload as Record<string, unknown>).account_id);
    }
    return null;
  },
};
