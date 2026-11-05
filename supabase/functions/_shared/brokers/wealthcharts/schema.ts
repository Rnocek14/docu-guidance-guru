// WealthCharts fill webhook payload — Meridian-proposed contract v1.
// This is the spec we hand WealthCharts (see Meridian x WealthCharts
// Integration Spec PDF). If their real payload differs, adjust here only.

import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

export const WealthChartsFillPayload = z.object({
  account_id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(128)),
  fill_id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(128)),
  order_id: z.union([z.string(), z.number()]).transform(String).optional(),
  timestamp: z.union([z.string(), z.number()]),
  symbol: z.string().min(1).max(32),
  side: z.string().min(1),
  qty: z.number().positive().max(10_000),
  price: z.number().positive(),
  commission: z.number().nonnegative().optional(),
  fees: z.number().nonnegative().optional(),
  realized_pnl: z.number().optional(),
  event_type: z.enum(['fill', 'cancel', 'correct']).default('fill'),
}).passthrough();

export type WealthChartsFillPayloadType = z.infer<typeof WealthChartsFillPayload>;

export function normalizeSide(side: string): 'buy' | 'sell' {
  const s = side.toLowerCase();
  if (s === 'buy' || s === 'b' || s === 'long') return 'buy';
  if (s === 'sell' || s === 's' || s === 'short') return 'sell';
  throw new Error(`Unknown side value: '${side}'`);
}

export function parseTimestamp(ts: string | number): string {
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  const n = Number(ts);
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const parsed = Date.parse(ts);
  if (isNaN(parsed)) throw new Error(`Invalid timestamp: ${ts}`);
  return new Date(parsed).toISOString();
}
