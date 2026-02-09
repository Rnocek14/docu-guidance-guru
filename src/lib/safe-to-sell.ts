/**
 * Pure function for the "Safe to Sell?" executive signal.
 * Safe = strictly proven, not inferred. Missing data = NOT SAFE.
 */

export type Signal = 'green' | 'yellow' | 'red';

export interface FreshnessInfo {
  signal: Signal;
  configMissing?: boolean;
}

export interface SafeToSellInputs {
  paymentState: { is_paused_inbound: boolean; pause_reason?: string | null } | undefined;
  freshness: Record<string, FreshnessInfo> | undefined;
  breakerLevel: string | undefined;
  snapshotNetBuffer: number | null | undefined;
  hasDisputeData: boolean;
  hasRedCard: boolean;
}

export interface SafeToSellResult {
  safe: boolean;
  reasons: string[];
}

export function getSafeToSell(inputs: SafeToSellInputs): SafeToSellResult {
  const { paymentState: ps, freshness: fr, breakerLevel, snapshotNetBuffer, hasDisputeData, hasRedCard } = inputs;

  const missingCriticalData = !ps || !fr || breakerLevel === undefined || snapshotNetBuffer === undefined || !hasDisputeData;

  const freshnessRed = fr
    ? Object.values(fr).some((j) => j.signal === 'red')
    : true;
  const freshnessConfigDrift = fr
    ? Object.values(fr).some((j) => !!j.configMissing)
    : true;

  const inboundPaused = ps?.is_paused_inbound ?? true;
  const breakerBlockingForSale = breakerLevel ? breakerLevel !== 'normal' : true;
  const bufferNegative = snapshotNetBuffer !== undefined && snapshotNetBuffer !== null
    ? Number(snapshotNetBuffer) <= 0
    : true;

  const reasons: string[] = [];
  if (missingCriticalData) reasons.push('Metrics incomplete');
  if (hasRedCard) reasons.push('Red metric(s) active');
  if (freshnessRed) reasons.push('Data freshness RED');
  if (freshnessConfigDrift) reasons.push('Cron config drift');
  if (inboundPaused) reasons.push(ps?.pause_reason ? `Inbound paused: ${ps.pause_reason}` : 'Inbound payments paused');
  if (breakerBlockingForSale) reasons.push(`Breaker: ${breakerLevel ?? 'unknown'}`);
  if (bufferNegative) reasons.push('Net buffer ≤ 0');

  return { safe: reasons.length === 0, reasons };
}
