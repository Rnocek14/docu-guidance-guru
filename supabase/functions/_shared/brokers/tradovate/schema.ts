// Tradovate webhook payload schema
// NOTE: Adjust field names once you paste a real Tradovate webhook sample.
// This schema covers the common fill event structure.

import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

/**
 * Tradovate fill event payload.
 * Uses .passthrough() to preserve unknown fields in the raw trace.
 */
export const TradovoteFillPayload = z.object({
  // Account identifier on Tradovate side
  accountId: z.union([z.string(), z.number()]).transform(String),
  // Unique trade/fill ID from Tradovate
  tradeId: z.union([z.string(), z.number()]).transform(String),
  // Fill timestamp (epoch ms or ISO string)
  timestamp: z.union([z.string(), z.number()]),
  // Instrument
  symbol: z.string().min(1),
  // Side
  side: z.enum(['Buy', 'Sell', 'BUY', 'SELL', 'buy', 'sell']),
  // Quantity
  qty: z.number().positive(),
  // Fill price
  price: z.number().optional(),
  // Realized PnL if provided by Tradovate
  pnl: z.number().optional(),
  // Commission charged
  commission: z.number().optional(),
  // Fees
  fees: z.number().optional(),
  // Event type hint
  eventType: z.string().optional(),
}).passthrough();

export type TradovoteFillPayloadType = z.infer<typeof TradovoteFillPayload>;

/**
 * Normalize side to lowercase canonical form.
 */
export function normalizeSide(side: string): 'buy' | 'sell' {
  return side.toLowerCase() === 'buy' ? 'buy' : 'sell';
}

/**
 * Parse Tradovate timestamp to ISO string.
 * Handles epoch milliseconds (number) or ISO string.
 */
export function parseTimestamp(ts: string | number): string {
  if (typeof ts === 'number') {
    return new Date(ts).toISOString();
  }
  const parsed = Date.parse(ts);
  if (isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${ts}`);
  }
  return new Date(parsed).toISOString();
}
