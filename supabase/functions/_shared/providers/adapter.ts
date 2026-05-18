// Provider lifecycle adapter interface
// Each white-label / trading platform implements this contract.
// Separate from BrokerAdapter (webhook ingestion) — this handles API calls OUT to providers.

import type {
  ProviderId,
  ProvisionRequest,
  ProvisionResult,
  DisableRequest,
  DisableResult,
  AccountStatusResult,
} from './types.ts';

export interface ProviderAdapter {
  id: ProviderId;

  /**
   * Create a sim account at the provider.
   * Called after checkout fulfillment.
   */
  provisionAccount(req: ProvisionRequest): Promise<ProvisionResult>;

  /**
   * Disable/freeze a sim account at the provider.
   * Must complete in <5 seconds for breach enforcement.
   */
  disableAccount(req: DisableRequest): Promise<DisableResult>;

  /**
   * Query account status from the provider.
   * Used for reconciliation and health checks.
   */
  getAccountStatus?(externalAccountId: string): Promise<AccountStatusResult>;
}

// Provider registry — lazy-loaded adapters
const providers = new Map<ProviderId, () => Promise<ProviderAdapter>>();

export function registerProvider(id: ProviderId, loader: () => Promise<ProviderAdapter>) {
  providers.set(id, loader);
}

export async function getProvider(id: ProviderId): Promise<ProviderAdapter | null> {
  const loader = providers.get(id);
  if (!loader) return null;
  return loader();
}

export function getRegisteredProviders(): ProviderId[] {
  return Array.from(providers.keys());
}

// ── Provider Registry ──
// Register WealthCharts (currently a stub; replace adapter file when API
// access is available — no other changes required).
registerProvider('wealthcharts', async () => {
  const { WealthChartsProvider } = await import('./wealthcharts/adapter.ts');
  return WealthChartsProvider;
});

// Register new providers here as they become available:
// registerProvider('vendor_x', async () => {
//   const { VendorXProvider } = await import('./vendor_x/adapter.ts');
//   return VendorXProvider;
// });

/**
 * Resolve the currently active provider for lifecycle calls (provisioning,
 * disable, reconciliation). Controlled by the `ACTIVE_PROVIDER` edge function
 * env var so rollout can be toggled without code changes.
 *
 * Returns `null` when:
 *   - `ACTIVE_PROVIDER` is unset / empty (system runs as today, no-op)
 *   - `ACTIVE_PROVIDER` references an unregistered id (logged warning)
 *
 * Callers MUST treat a null result as "no provider configured — skip" and
 * never throw, so provider rollout is fully decoupled from the rest of the
 * platform.
 */
export async function getActiveProvider(): Promise<ProviderAdapter | null> {
  const id = (Deno.env.get('ACTIVE_PROVIDER') ?? '').trim();
  if (!id) return null;
  const adapter = await getProvider(id);
  if (!adapter) {
    console.warn(`getActiveProvider: ACTIVE_PROVIDER=${id} is not registered`);
    return null;
  }
  return adapter;
}
