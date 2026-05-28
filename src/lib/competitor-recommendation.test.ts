import { describe, it, expect } from 'vitest';
import { recommendCohort, _internal, type RulesByFirmSize } from './competitor-recommendation';
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
    // No data → solvent == current on every field → status is 'no_change'.
    expect(r.status).toBe('no_change');
  });

  it('flags status="insufficient_data" when n=1 or 2', () => {
    const r1 = recommendCohort('starter', [makeSnap('apex', 50_000, { payout_split_pct: 90 }, 147)]);
    expect(r1.status).toBe('insufficient_data');
    const r2 = recommendCohort('starter', [
      makeSnap('apex', 50_000, { payout_split_pct: 90 }, 147),
      makeSnap('topstep', 50_000, { payout_split_pct: 90 }, 165),
    ]);
    expect(r2.status).toBe('insufficient_data');
  });

  it('passes through a competitor split that sits inside the solvency band', () => {
    const snaps = [
      makeSnap('apex', 50_000, { payout_split_pct: 90 }, 147),
      makeSnap('topstep', 50_000, { payout_split_pct: 90 }, 165),
      makeSnap('mffu', 50_000, { payout_split_pct: 90 }, 80),
    ];
    const r = recommendCohort('starter', snaps);
    const split = r.rows.find((x) => x.field === 'payout_split_percent')!;
    expect(split.median).toBe(90);
    expect(split.solvent).toBe(90);
    expect(split.clamped).toBe(false);
    expect(r.proposedCohort.payout_split_percent).toBe(90);
    expect(r.status).toBe('ok');
    expect(r.changedFields).toContain('payout_split_percent');
  });

  it('caps a runaway 99% split at the 95% ceiling', () => {
    const snaps = [
      makeSnap('x', 50_000, { payout_split_pct: 99 }, 100),
      makeSnap('y', 50_000, { payout_split_pct: 99 }, 100),
      makeSnap('z', 50_000, { payout_split_pct: 99 }, 100),
    ];
    const r = recommendCohort('starter', snaps);
    const split = r.rows.find((x) => x.field === 'payout_split_percent')!;
    expect(split.median).toBe(99);
    expect(split.solvent).toBe(95);
    expect(split.clamped).toBe(true);
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
    // n=1 in each bucket → insufficient_data, not ok.
    expect(pro.status).toBe('insufficient_data');
  });

  it('omits reset fee row (lives on reset-bundles SSOT, not cohorts row)', () => {
    const r = recommendCohort('starter', []);
    expect(r.rows.find((x) => x.field === 'reset_fee')).toBeUndefined();
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

  describe('rulesByFirmSize (per-(firm, size) coverage)', () => {
    // All three firms have a 50K snapshot; rules-by-size adds 100K and 200K
    // rules for the firms we've actually scraped at those sizes.
    const snaps = [
      makeSnap('apex', 50_000, {}, 147),
      makeSnap('topstep', 50_000, {}, 165),
      makeSnap('mffu', 50_000, {}, 80),
    ];

    it('produces an ok Pro recommendation when ≥3 firms have 100K rules', () => {
      const map: RulesByFirmSize = {
        apex: { 100_000: { payout_split_pct: 90, profit_target_usd: 6_000, daily_loss_usd: 3_000, max_drawdown_usd: 3_000, first_payout_cap_usd: 1_500, payout_cadence_days: 8, account_size_usd: 100_000 } },
        topstep: { 100_000: { payout_split_pct: 90, profit_target_usd: 9_000, daily_loss_usd: 3_000, max_drawdown_usd: 3_000, first_payout_cap_usd: 5_000, payout_cadence_days: 8, account_size_usd: 100_000 } },
        mffu: { 100_000: { payout_split_pct: 90, profit_target_usd: 8_000, daily_loss_usd: 3_500, max_drawdown_usd: 3_000, first_payout_cap_usd: 9_000, payout_cadence_days: 14, account_size_usd: 100_000 } },
      };
      const r = recommendCohort('pro', snaps, map);
      expect(r.status).toBe('ok');
      expect(r.sourceFirms.sort()).toEqual(['apex', 'mffu', 'topstep']);
    });

    it('flags Elite as insufficient_data when only 2 firms have 200K rules', () => {
      const map: RulesByFirmSize = {
        apex: { 200_000: { payout_split_pct: 90, profit_target_usd: 12_000, daily_loss_usd: 6_000, max_drawdown_usd: 6_000, first_payout_cap_usd: 2_000, payout_cadence_days: 8, account_size_usd: 200_000 } },
        topstep: { 200_000: { payout_split_pct: 90, profit_target_usd: 18_000, daily_loss_usd: 6_000, max_drawdown_usd: 6_000, first_payout_cap_usd: 5_000, payout_cadence_days: 8, account_size_usd: 200_000 } },
      };
      const r = recommendCohort('elite', snaps, map);
      expect(r.status).toBe('insufficient_data');
      expect(r.sourceFirms.length).toBe(2);
    });

    it('does not let a firm with only 50K rules contaminate Pro/Elite medians', () => {
      const map: RulesByFirmSize = {
        apex: { 50_000: { payout_split_pct: 90, account_size_usd: 50_000 } },
        topstep: { 50_000: { payout_split_pct: 90, account_size_usd: 50_000 } },
        mffu: { 50_000: { payout_split_pct: 90, account_size_usd: 50_000 } },
      };
      const pro = recommendCohort('pro', snaps, map);
      expect(pro.sourceFirms).toEqual([]);
      expect(pro.status).toBe('no_change');
    });
  });
});
