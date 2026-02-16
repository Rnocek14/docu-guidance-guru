// Canonical types for the platform-agnostic broker adapter layer

export type BrokerId = 'tradovate' | (string & {});

export type IngestDecision =
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'REJECTED_SIGNATURE'
  | 'REJECTED_SCHEMA'
  | 'REJECTED_TIME_SKEW'
  | 'REJECTED_DISABLED'
  | 'QUARANTINED_UNKNOWN_ACCOUNT'
  | 'QUARANTINED_INCONSISTENT'
  | 'ERROR';

export interface BrokerWebhookContext {
  broker: BrokerId;
  requestId: string;
  receivedAt: string; // ISO
  ip?: string;
  userAgent?: string;
}

export interface CanonicalTrade {
  broker: BrokerId;
  // mapping / identity
  externalAccountId: string;      // broker-side account identifier
  externalTradeId: string;        // idempotency key from broker payload
  occurredAt: string;             // ISO timestamp from broker
  receivedAt: string;             // ISO now
  // instrument
  symbolRaw: string;
  symbolNormalized: string;
  assetClass: 'futures' | 'forex' | 'equities' | 'options' | 'crypto' | 'unknown';
  // economics
  side: 'buy' | 'sell';
  qty: number;
  price: number | null;
  commission: number | null;
  fees: number | null;
  pnl: number | null;
  // semantics
  eventType: 'fill' | 'cancel' | 'correct' | 'unknown';
  // raw + trace
  raw: unknown;
  hash: string;                   // sha256 of stable-stringified raw
}

export interface AdapterParseResult {
  ok: boolean;
  decision: IngestDecision;
  reason?: string;
  canonical?: CanonicalTrade;
  signatureVerified?: boolean;
  replayWindowOk?: boolean;
  schemaOk?: boolean;
}

export interface AdapterVerifyResult {
  ok: boolean;
  decision: IngestDecision;
  reason?: string;
}

export interface IngestResult {
  ok: boolean;
  decision: IngestDecision;
  reason?: string;
  requestId: string;
  tradeId?: string;     // internal trade row id, if created
  accountId?: string;   // internal account row id, if mapped
  duplicate?: boolean;
  breachDetected?: boolean;
  accountPassed?: boolean;
}
