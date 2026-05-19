import { describe, expect, it } from 'vitest';
import { RESET_BUNDLES as CLIENT_BUNDLES } from './reset-bundles';
import { RESET_BUNDLES as SERVER_BUNDLES } from '../../supabase/functions/_shared/reset-bundles';

/**
 * SSOT parity guard for reset-bundle pricing.
 *
 * Server is authoritative — Stripe line-item amounts are read from
 * supabase/functions/_shared/reset-bundles.ts. The client mirror in
 * src/lib/reset-bundles.ts MUST match on id/resetCount/priceUsd/urgencyOnly.
 * Drift here would mean trader-visible price ≠ Stripe-charged price.
 */
describe('reset-bundles SSOT parity', () => {
  it('client and server have the same bundle ids', () => {
    expect(Object.keys(CLIENT_BUNDLES).sort()).toEqual(Object.keys(SERVER_BUNDLES).sort());
  });

  it.each(Object.keys(SERVER_BUNDLES) as Array<keyof typeof SERVER_BUNDLES>)(
    'bundle "%s" matches server on price/count/urgency',
    (id) => {
      const s = SERVER_BUNDLES[id];
      const c = CLIENT_BUNDLES[id];
      expect(c, `client missing bundle ${id}`).toBeDefined();
      expect(c.id).toBe(s.id);
      expect(c.resetCount).toBe(s.resetCount);
      expect(c.priceUsd).toBe(s.priceUsd);
      expect(Boolean(c.urgencyOnly)).toBe(Boolean(s.urgencyOnly));
    },
  );
});