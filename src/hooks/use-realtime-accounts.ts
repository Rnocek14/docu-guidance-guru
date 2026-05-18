import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Subscribe to realtime UPDATEs on the `accounts` table for a given user and
 * invalidate any react-query cache entries that depend on accounts so the UI
 * reflects live balance / PnL / status changes pushed from the backend (trade
 * ingestion, breach enforcement, provisioning completion, etc.).
 *
 * RLS already restricts the user to their own rows, so the server-side filter
 * is `user_id=eq.<uid>` and the channel will only deliver rows the user is
 * allowed to see.
 */
export function useRealtimeAccounts(userId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`accounts:user:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'accounts',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Invalidate every query that depends on this user's accounts.
          // We use predicate matching so we don't have to enumerate every
          // page's queryKey here.
          queryClient.invalidateQueries({
            predicate: (q) => {
              const k = q.queryKey[0];
              return (
                typeof k === 'string' &&
                (k === 'trader-accounts' ||
                  k === 'account-details' ||
                  k === 'trader-total-paid' ||
                  k === 'account-payout' ||
                  k === 'account-violations' ||
                  k === 'account-daily-stats' ||
                  k === 'account-consistency' ||
                  k === 'payout-eligibility' ||
                  k === 'clean-payout-count')
              );
            },
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'accounts',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['trader-accounts', userId] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);
}