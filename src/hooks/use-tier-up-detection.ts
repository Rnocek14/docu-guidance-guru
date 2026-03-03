import { useRef, useEffect, useState, useCallback } from 'react';
import { LADDER_TIERS, calculateLadderProgress } from '@/lib/ladder-spec';
import type { LadderTier } from '@/lib/ladder-spec';

interface TierUpEvent {
  fromTier: LadderTier;
  toTier: LadderTier;
  cleanPayoutNumber: number;
}

/**
 * Detects when the trader crosses a ladder tier threshold.
 * Uses a ref to track the previous tier index so it only fires on
 * real-time transitions, not on mount/backfill.
 *
 * @param cleanPayoutCount - current clean payout count (undefined = not loaded)
 * @param scopeKey - lineage root id or account id; resets detection when it changes
 */
export function useTierUpDetection(
  cleanPayoutCount: number | undefined,
  scopeKey: string | undefined,
) {
  const prevTierIndexRef = useRef<number | null>(null);
  const prevScopeRef = useRef<string | undefined>(undefined);
  const [tierUpEvent, setTierUpEvent] = useState<TierUpEvent | null>(null);

  useEffect(() => {
    // Reset when scope (lineage/account) changes
    if (scopeKey !== prevScopeRef.current) {
      prevTierIndexRef.current = null;
      prevScopeRef.current = scopeKey;
      setTierUpEvent(null);
      // Don't return — fall through to seed with current value
    }

    if (cleanPayoutCount == null) return;

    const progress = calculateLadderProgress(cleanPayoutCount);
    const currentIdx = progress.currentTierIndex;

    // First render or after scope reset: seed the ref, don't trigger
    if (prevTierIndexRef.current === null) {
      prevTierIndexRef.current = currentIdx;
      return;
    }

    // Tier crossed upward
    if (currentIdx > prevTierIndexRef.current) {
      const fromTier = LADDER_TIERS[prevTierIndexRef.current];
      const toTier = LADDER_TIERS[currentIdx];
      setTierUpEvent({
        fromTier,
        toTier,
        cleanPayoutNumber: cleanPayoutCount,
      });
    }

    prevTierIndexRef.current = currentIdx;
  }, [cleanPayoutCount, scopeKey]);

  const dismissTierUp = useCallback(() => setTierUpEvent(null), []);

  return { tierUpEvent, dismissTierUp };
}
