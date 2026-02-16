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

// Register providers here as they become available:
// registerProvider('vendor_x', async () => {
//   const { VendorXProvider } = await import('./vendor_x/adapter.ts');
//   return VendorXProvider;
// });
