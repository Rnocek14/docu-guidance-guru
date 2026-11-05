import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { WealthChartsAdapter, hmacSha256Hex } from './adapter.ts';

const SECRET = 'wl_test_secret';
const ctx = () => ({ broker: 'wealthcharts', requestId: crypto.randomUUID(), receivedAt: new Date().toISOString() });
const body = JSON.stringify({
  account_id: 'WC-1001', fill_id: 'F-1', timestamp: Date.now(), symbol: 'MESZ6',
  side: 'Buy', qty: 2, price: 6012.25, commission: 0.74, event_type: 'fill',
});
const req = (h: Record<string, string>) => new Request('https://x/ingest', { method: 'POST', headers: h, body });

Deno.test('valid signature accepted', async () => {
  Deno.env.set('WEALTHCHARTS_WEBHOOK_SECRET', SECRET);
  const ts = String(Date.now());
  const sig = await hmacSha256Hex(SECRET, `${ts}.${body}`);
  const r = await WealthChartsAdapter.verify(req({ 'x-wl-timestamp': ts, 'x-wl-signature': sig }), body, ctx());
  assertEquals(r.decision, 'ACCEPTED');
});

Deno.test('wrong signature rejected', async () => {
  Deno.env.set('WEALTHCHARTS_WEBHOOK_SECRET', SECRET);
  const ts = String(Date.now());
  const sig = await hmacSha256Hex('other', `${ts}.${body}`);
  const r = await WealthChartsAdapter.verify(req({ 'x-wl-timestamp': ts, 'x-wl-signature': sig }), body, ctx());
  assertEquals(r.decision, 'REJECTED_SIGNATURE');
});

Deno.test('replay older than 5 min rejected', async () => {
  Deno.env.set('WEALTHCHARTS_WEBHOOK_SECRET', SECRET);
  const ts = String(Date.now() - 6 * 60 * 1000);
  const sig = await hmacSha256Hex(SECRET, `${ts}.${body}`);
  const r = await WealthChartsAdapter.verify(req({ 'x-wl-timestamp': ts, 'x-wl-signature': sig }), body, ctx());
  assertEquals(r.decision, 'REJECTED_TIME_SKEW');
});

Deno.test('missing secret fails closed', async () => {
  Deno.env.delete('WEALTHCHARTS_WEBHOOK_SECRET');
  const r = await WealthChartsAdapter.verify(req({ 'x-wl-timestamp': '1', 'x-wl-signature': 'ab' }), body, ctx());
  assertEquals(r.ok, false);
});

Deno.test('parse maps to canonical trade', async () => {
  const r = await WealthChartsAdapter.parse(req({}), body, ctx());
  assertEquals(r.ok, true);
  assertEquals(r.canonical?.side, 'buy');
  assertEquals(r.canonical?.externalTradeId, 'F-1');
  assertEquals(r.canonical?.qty, 2);
});

Deno.test('zero qty rejected', async () => {
  const bad = JSON.stringify({ account_id: 'a', fill_id: 'f', timestamp: Date.now(), symbol: 'ES', side: 'buy', qty: 0, price: 1 });
  const r = await WealthChartsAdapter.parse(req({}), bad, ctx());
  assertEquals(r.decision, 'REJECTED_SCHEMA');
});
