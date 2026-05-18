// Platform-agnostic broker adapter interface
// Each broker (Tradovate, NinjaTrader, Rithmic) implements this contract.

import type {
  BrokerId,
  BrokerWebhookContext,
  AdapterVerifyResult,
  AdapterParseResult,
} from './types.ts';

export interface BrokerAdapter {
  id: BrokerId;

  /**
   * Verify signature + anti-replay. Must be fast and pure (no DB access).
   * Returns decision immediately if verification fails.
   */
  verify(
    req: Request,
    rawBody: string,
    ctx: BrokerWebhookContext
  ): Promise<AdapterVerifyResult>;

  /**
   * Parse + normalize raw webhook payload to CanonicalTrade.
   * No DB access — pure transformation.
   */
  parse(
    req: Request,
    rawBody: string,
    ctx: BrokerWebhookContext
  ): Promise<AdapterParseResult>;

  /**
   * Optional: derive a stable external account id from nested payload structures.
   */
  getExternalAccountId?(payload: unknown): string | null;
}

// Adapter registry — add new brokers here
const adapters = new Map<BrokerId, () => Promise<BrokerAdapter>>();

export function registerAdapter(id: BrokerId, loader: () => Promise<BrokerAdapter>) {
  adapters.set(id, loader);
}

export async function getAdapter(id: BrokerId): Promise<BrokerAdapter | null> {
  const loader = adapters.get(id);
  if (!loader) return null;
  return loader();
}

export function getRegisteredBrokers(): BrokerId[] {
  return Array.from(adapters.keys());
}

// Register Tradovate adapter (lazy import to keep cold starts fast)
registerAdapter('tradovate', async () => {
  const { TradovateAdapter } = await import('../brokers/tradovate/adapter.ts');
  return TradovateAdapter;
});

// Register WealthCharts adapter (currently a stub; replace adapter file when
// vendor webhook spec is available — no other changes required).
registerAdapter('wealthcharts', async () => {
  const { WealthChartsAdapter } = await import('../brokers/wealthcharts/adapter.ts');
  return WealthChartsAdapter;
});

// Register new broker adapters here as integrations are built:
// registerAdapter('ninjatrader', async () => {
//   const { NinjaTraderAdapter } = await import('../brokers/ninjatrader/adapter.ts');
//   return NinjaTraderAdapter;
// });
