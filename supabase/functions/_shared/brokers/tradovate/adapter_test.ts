import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { TradovateAdapter } from './adapter.ts';
import type { BrokerWebhookContext } from '../types.ts';
import {
  TRADOVATE_TEST_SECRET,
  VALID_FILL_PAYLOAD,
  MISSING_TRADE_ID_PAYLOAD,
  INVALID_SIDE_PAYLOAD,
  ZERO_QTY_PAYLOAD,
  CANCEL_PAYLOAD,
  generateTestSignature,
} from './test-vectors.ts';

// ── Helpers ──

function makeCtx(overrides?: Partial<BrokerWebhookContext>): BrokerWebhookContext {
  return {
    broker: 'tradovate',
    requestId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

// ── Verify Tests ──

Deno.test('verify — valid signature passes', async () => {
  Deno.env.set('TRADOVATE_WEBHOOK_SECRET', TRADOVATE_TEST_SECRET);

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const ts = String(Date.now());
  const sig = await generateTestSignature(TRADOVATE_TEST_SECRET, ts, rawBody);

  const req = makeRequest(rawBody, {
    'x-tv-timestamp': ts,
    'x-tv-signature': sig,
  });

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, true);
  assertEquals(result.decision, 'ACCEPTED');
});

Deno.test('verify — invalid signature rejected', async () => {
  Deno.env.set('TRADOVATE_WEBHOOK_SECRET', TRADOVATE_TEST_SECRET);

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const ts = String(Date.now());
  const sig = await generateTestSignature(TRADOVATE_TEST_SECRET, ts, rawBody);
  const badSig = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');

  const req = makeRequest(rawBody, {
    'x-tv-timestamp': ts,
    'x-tv-signature': badSig,
  });

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SIGNATURE');
});

Deno.test('verify — missing headers rejected', async () => {
  Deno.env.set('TRADOVATE_WEBHOOK_SECRET', TRADOVATE_TEST_SECRET);

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const req = makeRequest(rawBody); // no sig headers

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SIGNATURE');
});

Deno.test('verify — stale timestamp rejected (time skew)', async () => {
  Deno.env.set('TRADOVATE_WEBHOOK_SECRET', TRADOVATE_TEST_SECRET);

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const staleTs = String(Date.now() - 10 * 60 * 1000); // 10 min ago
  const sig = await generateTestSignature(TRADOVATE_TEST_SECRET, staleTs, rawBody);

  const req = makeRequest(rawBody, {
    'x-tv-timestamp': staleTs,
    'x-tv-signature': sig,
  });

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_TIME_SKEW');
});

Deno.test('verify — future timestamp rejected (>30s ahead)', async () => {
  Deno.env.set('TRADOVATE_WEBHOOK_SECRET', TRADOVATE_TEST_SECRET);

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const futureTs = String(Date.now() + 2 * 60 * 1000); // 2 min in future
  const sig = await generateTestSignature(TRADOVATE_TEST_SECRET, futureTs, rawBody);

  const req = makeRequest(rawBody, {
    'x-tv-timestamp': futureTs,
    'x-tv-signature': sig,
  });

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_TIME_SKEW');
});

Deno.test('verify — missing secret returns ERROR', async () => {
  Deno.env.delete('TRADOVATE_WEBHOOK_SECRET');

  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const req = makeRequest(rawBody, {
    'x-tv-timestamp': String(Date.now()),
    'x-tv-signature': 'deadbeef',
  });

  const result = await TradovateAdapter.verify(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'ERROR');
});

// ── Parse Tests ──

Deno.test('parse — valid fill payload accepted', async () => {
  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const req = makeRequest(rawBody);
  const ctx = makeCtx();

  const result = await TradovateAdapter.parse(req, rawBody, ctx);
  assertEquals(result.ok, true);
  assertEquals(result.decision, 'ACCEPTED');
  assertEquals(result.schemaOk, true);
  assertExists(result.canonical);
  assertEquals(result.canonical!.broker, 'tradovate');
  assertEquals(result.canonical!.externalAccountId, 'TV-12345');
  assertEquals(result.canonical!.externalTradeId, 'fill-abc-001');
  assertEquals(result.canonical!.symbolNormalized, 'NQ'); // NQZ5 → NQ
  assertEquals(result.canonical!.side, 'buy');
  assertEquals(result.canonical!.qty, 2);
  assertEquals(result.canonical!.assetClass, 'futures');
  assertEquals(result.canonical!.eventType, 'fill');
});

Deno.test('parse — missing tradeId rejected', async () => {
  const rawBody = JSON.stringify(MISSING_TRADE_ID_PAYLOAD);
  const req = makeRequest(rawBody);

  const result = await TradovateAdapter.parse(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SCHEMA');
  assertEquals(result.schemaOk, false);
});

Deno.test('parse — invalid side rejected', async () => {
  const rawBody = JSON.stringify(INVALID_SIDE_PAYLOAD);
  const req = makeRequest(rawBody);

  const result = await TradovateAdapter.parse(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SCHEMA');
});

Deno.test('parse — zero qty rejected', async () => {
  const rawBody = JSON.stringify(ZERO_QTY_PAYLOAD);
  const req = makeRequest(rawBody);

  const result = await TradovateAdapter.parse(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SCHEMA');
});

Deno.test('parse — cancel event type preserved', async () => {
  const rawBody = JSON.stringify(CANCEL_PAYLOAD);
  const req = makeRequest(rawBody);

  const result = await TradovateAdapter.parse(req, rawBody, makeCtx());
  assertEquals(result.ok, true);
  assertEquals(result.canonical!.eventType, 'cancel');
  assertEquals(result.canonical!.symbolNormalized, 'MES'); // MESH24 → MES
});

Deno.test('parse — invalid JSON rejected', async () => {
  const rawBody = 'not json {{{';
  const req = makeRequest(rawBody);

  const result = await TradovateAdapter.parse(req, rawBody, makeCtx());
  assertEquals(result.ok, false);
  assertEquals(result.decision, 'REJECTED_SCHEMA');
});

Deno.test('parse — hash is deterministic for same rawBody', async () => {
  const rawBody = JSON.stringify(VALID_FILL_PAYLOAD);
  const req1 = makeRequest(rawBody);
  const req2 = makeRequest(rawBody);
  const ctx = makeCtx();

  const r1 = await TradovateAdapter.parse(req1, rawBody, ctx);
  const r2 = await TradovateAdapter.parse(req2, rawBody, ctx);
  assertEquals(r1.canonical!.hash, r2.canonical!.hash);
});

Deno.test('getExternalAccountId — extracts from payload', () => {
  const result = TradovateAdapter.getExternalAccountId!({ accountId: 'TV-999' });
  assertEquals(result, 'TV-999');
});

Deno.test('getExternalAccountId — returns null for missing', () => {
  const result = TradovateAdapter.getExternalAccountId!({ foo: 'bar' });
  assertEquals(result, null);
});
