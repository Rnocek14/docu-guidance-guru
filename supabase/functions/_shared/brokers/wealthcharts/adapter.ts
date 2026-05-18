// WealthCharts BrokerAdapter — STUB IMPLEMENTATION (inbound trade webhooks)
//
// Parallel to providers/wealthcharts/adapter.ts (outbound). This handles
// inbound fill/trade webhooks FROM WealthCharts into ingest-trade.
//
// Every method returns a hard reject so that the moment WealthCharts begins
// posting webhooks before the real implementation is in place, requests are
// rejected with a clear reason (and visible in audit logs) — never silently
// accepted or treated as a different broker.
//
// WHEN YOU GET WEALTHCHARTS WEBHOOK SPEC:
//   1. Replace `verify` with HMAC validation using WEALTHCHARTS_WEBHOOK_SECRET
//      (mirror the Tradovate adapter: timestamp anti-replay + constant-time
//      hex compare).
//   2. Replace `parse` with payload → CanonicalTrade transformation, calling
//      `normalizeSymbol` for instrument metadata.
//   3. Add a Zod schema file (schema.ts) and adapter_test.ts mirroring the
//      Tradovate folder structure.
//   4. No changes required elsewhere — the registry + ingest-trade detection
//      already route x-wl-signature/x-wl-timestamp requests here.

import type { BrokerAdapter } from '../adapter.ts';
import type {
  BrokerWebhookContext,
  AdapterVerifyResult,
  AdapterParseResult,
} from '../types.ts';

const NOT_IMPLEMENTED = 'wealthcharts_broker_adapter_not_implemented';

export const WealthChartsAdapter: BrokerAdapter = {
  id: 'wealthcharts',

  async verify(
    _req: Request,
    _rawBody: string,
    _ctx: BrokerWebhookContext
  ): Promise<AdapterVerifyResult> {
    return {
      ok: false,
      decision: 'REJECTED_SIGNATURE',
      reason: NOT_IMPLEMENTED,
    };
  },

  async parse(
    _req: Request,
    _rawBody: string,
    _ctx: BrokerWebhookContext
  ): Promise<AdapterParseResult> {
    return {
      ok: false,
      decision: 'REJECTED_SCHEMA',
      reason: NOT_IMPLEMENTED,
    };
  },
};