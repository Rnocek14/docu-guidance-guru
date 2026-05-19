import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle2 } from 'lucide-react';

type PublicPayout = {
  short_id: string;
  display_name: string;
  amount: number;
  tier_name: string;
  paid_at: string | null;
};

/**
 * Minimal live ticker of recently-paid public payouts.
 * Pulls from the same RPC as /payouts (get_recent_public_payouts).
 * Hidden when no public payouts exist (avoids empty-state noise pre-launch).
 */
export function LivePayoutTicker() {
  const { data } = useQuery({
    queryKey: ['live-payout-ticker'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_recent_public_payouts', { _limit: 8 });
      if (error) throw error;
      return (data as PublicPayout[]) ?? [];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!data?.length) return null;

  // Duplicate the list so the marquee loops seamlessly.
  const items = [...data, ...data];

  return (
    <div className="border-t border-border bg-card/50 overflow-hidden">
      <div className="flex items-center gap-3 py-2 px-4 text-xs">
        <Link
          to="/payouts"
          className="flex items-center gap-1.5 text-success font-medium shrink-0 hover:underline"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
          </span>
          Live payouts
        </Link>
        <div className="relative flex-1 overflow-hidden">
          <div className="flex gap-6 animate-[ticker_60s_linear_infinite] whitespace-nowrap">
            {items.map((p, i) => (
              <Link
                key={`${p.short_id}-${i}`}
                to={`/p/${p.short_id}`}
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                <span className="font-medium text-foreground">{p.display_name}</span>
                <span>got paid</span>
                <span className="font-semibold text-foreground tabular-nums">
                  ${Number(p.amount).toLocaleString()}
                </span>
                {p.paid_at && (
                  <span className="text-muted-foreground/60">
                    · {formatDistanceToNow(new Date(p.paid_at), { addSuffix: true })}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
