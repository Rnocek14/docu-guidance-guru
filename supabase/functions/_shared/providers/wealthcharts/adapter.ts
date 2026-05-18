// WealthCharts ProviderAdapter — STUB IMPLEMENTATION
//
// This file exists so the system can be wired end-to-end before WealthCharts
// vendor API access is available. Every method intentionally returns a
// `not_implemented` error so that:
//
//   1. Wiring code (checkout, breach, reconciliation) is exercised in tests
//      and staging without silently no-oping.
//   2. Failures surface loudly via `staff_notifications` (lifecycle.ts) the
//      moment ACTIVE_PROVIDER=wealthcharts is enabled in production by mistake.
//   3. Replacing this file with the real implementation requires no changes
//      elsewhere in the codebase — the registry, lifecycle, and call sites
//      all stay the same.
//
// WHEN YOU GET WEALTHCHARTS API ACCESS:
//   1. Replace each method body with real HTTP calls to the vendor API.
//   2. Store the API key as the `WEALTHCHARTS_API_KEY` edge function secret.
//   3. Store the webhook signing secret as `WEALTHCHARTS_WEBHOOK_SECRET`.
//   4. Add a matching BrokerAdapter under `_shared/brokers/wealthcharts/` for
//      inbound trade webhooks (mirror the Tradovate pattern).

import type { ProviderAdapter } from '../adapter.ts';
import type {
  ProvisionRequest,
  ProvisionResult,
  DisableRequest,
  DisableResult,
  AccountStatusResult,
} from '../types.ts';

const NOT_IMPLEMENTED = 'wealthcharts_adapter_not_implemented';

export const WealthChartsProvider: ProviderAdapter = {
  id: 'wealthcharts',

  async provisionAccount(_req: ProvisionRequest): Promise<ProvisionResult> {
    return {
      ok: false,
      error: NOT_IMPLEMENTED,
      httpStatus: 501,
      latencyMs: 0,
    };
  },

  async disableAccount(_req: DisableRequest): Promise<DisableResult> {
    return {
      ok: false,
      confirmed: false,
      error: NOT_IMPLEMENTED,
      httpStatus: 501,
      latencyMs: 0,
    };
  },

  async getAccountStatus(_externalAccountId: string): Promise<AccountStatusResult> {
    return {
      ok: false,
      error: NOT_IMPLEMENTED,
      httpStatus: 501,
      latencyMs: 0,
    };
  },
};