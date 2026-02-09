import { describe, it, expect } from 'vitest';
import { getSafeToSell, SafeToSellInputs } from './safe-to-sell';

const allGreen: SafeToSellInputs = {
  paymentState: { is_paused_inbound: false },
  freshness: {
    'daily-risk-snapshot': { signal: 'green' },
    'check-dispute-rate': { signal: 'green' },
  },
  breakerLevel: 'normal',
  snapshotNetBuffer: 50000,
  hasDisputeData: true,
  hasRedCard: false,
  reserveGate: { enabled: true, hasSimRunId: true },
};

describe('getSafeToSell', () => {
  it('returns safe when all inputs are green', () => {
    const result = getSafeToSell(allGreen);
    expect(result.safe).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('returns NOT safe when paymentState is missing', () => {
    const result = getSafeToSell({ ...allGreen, paymentState: undefined });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Metrics incomplete');
    expect(result.reasons).toContain('Inbound payments paused');
  });

  it('returns NOT safe when freshness is missing', () => {
    const result = getSafeToSell({ ...allGreen, freshness: undefined });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Metrics incomplete');
  });

  it('returns NOT safe when breaker is missing', () => {
    const result = getSafeToSell({ ...allGreen, breakerLevel: undefined });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Metrics incomplete');
    expect(result.reasons).toContain('Breaker: unknown');
  });

  it('returns NOT safe when breaker is elevated', () => {
    const result = getSafeToSell({ ...allGreen, breakerLevel: 'elevated' });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Breaker: elevated');
  });

  it('returns NOT safe when breaker is critical', () => {
    const result = getSafeToSell({ ...allGreen, breakerLevel: 'critical' });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Breaker: critical');
  });

  it('returns NOT safe when inbound is paused', () => {
    const result = getSafeToSell({
      ...allGreen,
      paymentState: { is_paused_inbound: true, pause_reason: 'Dispute rate spike' },
    });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Inbound paused: Dispute rate spike');
  });

  it('returns NOT safe when net buffer is zero', () => {
    const result = getSafeToSell({ ...allGreen, snapshotNetBuffer: 0 });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Net buffer ≤ 0');
  });

  it('returns NOT safe when net buffer is negative', () => {
    const result = getSafeToSell({ ...allGreen, snapshotNetBuffer: -1000 });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Net buffer ≤ 0');
  });

  it('returns NOT safe when any card is red', () => {
    const result = getSafeToSell({ ...allGreen, hasRedCard: true });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Red metric(s) active');
  });

  it('returns NOT safe when freshness has a red job', () => {
    const result = getSafeToSell({
      ...allGreen,
      freshness: {
        'daily-risk-snapshot': { signal: 'red' },
        'check-dispute-rate': { signal: 'green' },
      },
    });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Data freshness RED');
  });

  it('returns NOT safe when freshness has config drift', () => {
    const result = getSafeToSell({
      ...allGreen,
      freshness: {
        'daily-risk-snapshot': { signal: 'green', configMissing: true },
      },
    });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Cron config drift');
  });

  it('returns NOT safe when dispute data is missing', () => {
    const result = getSafeToSell({ ...allGreen, hasDisputeData: false });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Metrics incomplete');
  });

  it('accumulates multiple reasons', () => {
    const result = getSafeToSell({
      paymentState: { is_paused_inbound: true },
      freshness: { job: { signal: 'red', configMissing: true } },
      breakerLevel: 'critical',
      snapshotNetBuffer: -500,
      hasDisputeData: false,
      hasRedCard: true,
      reserveGate: undefined,
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(7);
  });

  it('returns NOT safe when reserve gate is missing', () => {
    const result = getSafeToSell({ ...allGreen, reserveGate: undefined });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Reserve gate not configured or missing simulation run');
  });

  it('returns NOT safe when reserve gate is disabled', () => {
    const result = getSafeToSell({ ...allGreen, reserveGate: { enabled: false, hasSimRunId: true } });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Reserve gate not configured or missing simulation run');
  });

  it('returns NOT safe when reserve gate has no simulation run', () => {
    const result = getSafeToSell({ ...allGreen, reserveGate: { enabled: true, hasSimRunId: false } });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain('Reserve gate not configured or missing simulation run');
  });
});
