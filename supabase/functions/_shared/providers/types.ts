// Provider-agnostic types for white-label / platform integrations
// Covers account provisioning, disabling, and status queries.

export type ProviderId = string; // e.g. 'tradovate', 'ninjatrader', 'vendor_x'

export interface ProvisionRequest {
  /** Internal Meridian account ID */
  accountId: string;
  /** Starting balance for the sim account */
  startingBalance: number;
  /** Cohort/tier info for the provider */
  tierLabel: string;
  /** User display name (for provider-side labeling) */
  userName?: string;
  /** Additional provider-specific config */
  metadata?: Record<string, unknown>;
}

export interface ProvisionResult {
  ok: boolean;
  /** Provider-side account identifier */
  externalAccountId?: string;
  /** Provider-side user identifier (if separate) */
  externalUserId?: string;
  /** Provider response metadata */
  providerMetadata?: Record<string, unknown>;
  error?: string;
  /** HTTP status from provider API */
  httpStatus?: number;
  /** Round-trip latency in ms */
  latencyMs?: number;
}

export interface DisableRequest {
  /** Internal Meridian account ID */
  accountId: string;
  /** Provider-side account identifier */
  externalAccountId: string;
  /** Reason for disabling */
  reason: 'breach' | 'manual' | 'expired' | 'fraud';
  /** Breach details for logging */
  breachType?: string;
}

export interface DisableResult {
  ok: boolean;
  /** Provider confirmed the disable */
  confirmed: boolean;
  error?: string;
  httpStatus?: number;
  latencyMs?: number;
}

export interface AccountStatusResult {
  ok: boolean;
  /** Provider-reported status */
  externalStatus?: string;
  /** Current balance according to provider */
  balance?: number;
  /** Whether the account is actively tradeable */
  isTradeable?: boolean;
  error?: string;
  httpStatus?: number;
  latencyMs?: number;
}
