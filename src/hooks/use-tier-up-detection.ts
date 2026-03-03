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
 */
export function useTierUpDetection(cleanPayoutCount: number | undefined) {
  const prevTierIndexRef = useRef<number | null>(null);
  const [tierUpEvent, setTierUpEvent] = useState<TierUpEvent | null>(null);

  useEffect(() => {
    if (cleanPayoutCount == null) return;

    const progress = calculateLadderProgress(cleanPayoutCount);
    const currentIdx = progress.currentTierIndex;

    // First render: seed the ref, don't trigger
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
  }, [cleanPayoutCount]);

  const dismissTierUp = useCallback(() => setTierUpEvent(null), []);

  return { tierUpEvent, dismissTierUp };
}
