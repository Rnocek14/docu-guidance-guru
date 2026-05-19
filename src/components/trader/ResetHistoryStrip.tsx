import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { RESET_BUNDLES, type ResetBundleId } from '@/lib/reset-bundles';

/**
 * Compact strip showing banked + recent reset purchases for the signed-in trader.
 * Designed to live above the fold on the trader dashboard.
 */
export function ResetHistoryStrip() {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['reset-history', user?.id],
    queryFn: async () => {
      const { data: purchases, error } = await supabase
        .from('reset_purchases')
        .select('id, bundle_id, status, resets_total, created_at, account_id, restored_account, applied_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      const { data: accounts } = await supabase
        .from('accounts')
        .select('reset_credits_remaining')
        .eq('user_id', user!.id);
      const banked = (accounts ?? []).reduce(
        (sum, a) => sum + (a.reset_credits_remaining ?? 0),
        0,
      );
      return { purchases: purchases ?? [], banked };
    },
    enabled: !!user?.id,
  });

  if (!data || data.purchases.length === 0) return null;
  const { purchases, banked } = data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-primary" />
            Reset history
          </span>
          {banked > 0 && (
            <Badge variant="secondary">{banked} banked</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {purchases.map((p) => {
          const bundle = RESET_BUNDLES[p.bundle_id as ResetBundleId];
          return (
            <Link
              key={p.id}
              to={`/trader/accounts/${p.account_id}`}
              className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm hover:border-primary/40"
            >
              <div>
                <p className="font-medium text-foreground">{bundle?.label ?? p.bundle_id}</p>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(p.created_at), 'MMM d, yyyy')} · {p.resets_total} reset{p.resets_total > 1 ? 's' : ''}
                  {p.restored_account ? ' · account restored' : p.applied_at ? ' · credits banked' : ''}
                </p>
              </div>
              <Badge variant={p.status === 'paid' ? 'secondary' : p.status === 'pending' ? 'outline' : 'default'}>
                {p.status}
              </Badge>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
