import { describe, it, expect } from 'vitest';
import { recommendCohort, _internal } from './competitor-recommendation';
import type { SnapshotInput } from './competitor-comparison';

function makeSnap(firm: string, sz: number, overrides: Partial<SnapshotInput['payload']['rules']> = {}, price?: number): SnapshotInput {
  return {
    firm_id: firm,
    firm_name: firm,
    captured_at: '2026-05-28T00:00:00Z',
    payload: {
      pricing: price != null ? [{ account_size_label: `${sz / 1000}K`, list_price_usd: price, promo_price_usd: null }] : [],
      rules: {
        account_size_usd: sz,
        profit_target_usd: sz * 0.06,
        daily_loss_usd: sz * 0.04,
        max_drawdown_usd: sz * 0.05,
        payout_split_pct: 90,
        first_payout_cap_usd: 2000,
        payout_cadence_days: 8,
        reset_fee_usd: 70,
        ...overrides,
      },
    },
  };
}

describe('median helper', () => {
  it('handles odd/even', () => {
    expect(_internal.median([1, 3, 2])).toBe(2);
    expect(_internal.median([1, 2, 3, 4])).toBe(2.5);
  });
  it('skips nullish', () => {
    expect(_internal.median([1, null, 3, undefined])).toBe(2);
  });
  it('returns null for empty', () => {
    expect(_internal.median([])).toBeNull();
    expect(_internal.median([null, null])).toBeNull();
  });
});

describe('clamp helper', () => {
  it('clamps low and high', () => {
    expect(_internal.clamp(5, 10, 20)).toEqual({ v: 10, clamped: 'lo' });
    expect(_internal.clamp(25, 10, 20)).toEqual({ v: 20, clamped: 'hi' });
    expect(_internal.clamp(15, 10, 20)).toEqual({ v: 15, clamped: null });
  });
});

describe('recommendCohort', () => {
  it('produces rows for the starter tier with empty snapshots', () => {
    const r = recommendCohort('starter', []);
    expect(r.tierId).toBe('starter');
    expect(r.rows.length).toBeGreaterThan(0);
    // No competitor data → median is null, solvent falls back to current.
    const split = r.rows.find((x) => x.field === 'payout_split_percent')!;
    expect(split.median).toBeNull();
    expect(split.solvent).toBe(80);
    expect(r.sourceFirms).toEqual([]);
  });

  it('clamps a generous 90% split down to 80% solvency floor', () => {
    const snaps = [
      makeSnap('apex', 50_000, { payout_split_pct: 90 }, 147),
      makeSnap('topstep', 50_000, { payout_split_pct: 90 }, 165),
      makeSnap('mffu', 50_000, { payout_split_pct: 90 }, 80),
    ];
    const r = recommendCohort('starter', snaps);
    const split = r.rows.find((x) => x.field === 'payout_split_percent')!;
    expect(split.median).toBe(90);
    expect(split.solvent).toBe(80);
    expect(split.clamped).toBe(true);
    expect(r.proposedCohort.payout_split_percent).toBe(80);
  });

  it('respects entry-fee whiplash guardrails', () => {
    const snaps = [
      makeSnap('apex', 50_000, {}, 30), // crazy low
      makeSnap('topstep', 50_000, {}, 35),
      makeSnap('mffu', 50_000, {}, 40),
    ];
    const r = recommendCohort('starter', snaps);
    const ef = r.rows.find((x) => x.field === 'entry_fee')!;
    expect(ef.median).toBeLessThan(50);
    // Floor is 70% of $149 = $104
    expect(ef.solvent).toBe(Math.round(149 * 0.7));
    expect(ef.clamped).toBe(true);
  });

  it('buckets snapshots by account size', () => {
    const snaps = [
      makeSnap('apex50', 50_000),
      makeSnap('apex100', 100_000),
      makeSnap('apex200', 200_000),
    ];
    const pro = recommendCohort('pro', snaps);
    expect(pro.sourceFirms).toEqual(['apex100']);
    const elite = recommendCohort('elite', snaps);
    expect(elite.sourceFirms).toEqual(['apex200']);
  });

  it('produces a proposedCohort with all required fields', () => {
    const r = recommendCohort('starter', [makeSnap('apex', 50_000, {}, 147)]);
    const c = r.proposedCohort;
    expect(c.tier_id).toBe('starter');
    expect(c.cohort_phase).toBe('performance');
    expect(c.name).toMatch(/^Recommended Starter/);
    expect(c.entry_fee).toBeGreaterThan(0);
    expect(c.profit_target_percent).toBeGreaterThan(0);
    expect(c.payout_split_percent).toBeGreaterThanOrEqual(80);
  });
});
