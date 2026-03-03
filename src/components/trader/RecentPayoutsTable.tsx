import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckCircle2, XCircle, Clock, Banknote, Sparkles } from 'lucide-react';
import { format } from 'date-fns';

interface RecentPayoutsTableProps {
  accountId: string;
  /** If true, the most recent clean-paid row gets a "Tier Up" badge */
  highlightTierUp?: boolean;
}

type PayoutRow = {
  id: string;
  amount: number;
  status: string;
  requested_at: string;
  paid_at: string | null;
  is_clean_payout: boolean | null;
  clean_payout_reason: string | null;
};

const REASON_LABELS: Record<string, string> = {
  ACTIVE_FLAG: 'A compliance flag was active on your account when this payout was confirmed.',
  BREAKER_L2: 'System was in emergency freeze mode when this payout was confirmed.',
};

const TERMINAL_PAID = ['paid', 'paid_confirmed'];

function CleanBadge({ isClean, reason, status }: { isClean: boolean | null; reason: string | null; status: string }) {
  if (isClean === true) {
    return (
      <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950">
        <CheckCircle2 className="h-3 w-3" />
        Clean
      </Badge>
    );
  }

  if (isClean === false) {
    const tooltip = (reason && REASON_LABELS[reason]) || reason || 'Did not meet clean payout criteria.';
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-destructive border-destructive/30 bg-destructive/10 cursor-help">
              <XCircle className="h-3 w-3" />
              Not clean
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="text-xs">{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Only show "Pending" for terminal-paid rows awaiting classification
  if (TERMINAL_PAID.includes(status)) {
    return (
      <Badge variant="outline" className="gap-1 text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950">
        <Clock className="h-3 w-3" />
        Pending
      </Badge>
    );
  }

  // Non-terminal statuses: clean column is not applicable
  return <span className="text-xs text-muted-foreground">—</span>;
}

function statusLabel(status: string) {
  switch (status) {
    case 'paid':
    case 'paid_confirmed':
      return <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">Paid</Badge>;
    case 'payment_initiated':
      return <Badge variant="outline" className="text-blue-600 dark:text-blue-400">Processing</Badge>;
    case 'approved':
      return <Badge variant="outline" className="text-sky-600 dark:text-sky-400">Approved</Badge>;
    case 'requested':
      return <Badge variant="outline" className="text-amber-600 dark:text-amber-400">Requested</Badge>;
    case 'rejected':
      return <Badge variant="destructive">Rejected</Badge>;
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function RecentPayoutsTable({ accountId, highlightTierUp = false }: RecentPayoutsTableProps) {
  const { data: payouts, isLoading } = useQuery({
    queryKey: ['recent-payouts', accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payouts')
        .select('id, amount, status, requested_at, paid_at, is_clean_payout, clean_payout_reason')
        .eq('account_id', accountId)
        .order('requested_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return data as PayoutRow[];
    },
    enabled: !!accountId,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Banknote className="h-4 w-4 text-muted-foreground" />
            Recent Payouts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-20 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        </CardContent>
      </Card>
    );
  }

  if (!payouts?.length) return null;

  // Find the first clean-paid row for tier-up highlight
  const tierUpRowId = highlightTierUp
    ? payouts.find((p) => p.is_clean_payout === true && TERMINAL_PAID.includes(p.status))?.id
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Banknote className="h-4 w-4 text-muted-foreground" />
          Recent Payouts
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Clean</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payouts.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm">
                  <span className="flex items-center gap-1.5">
                    {format(new Date(p.requested_at), 'MMM d, yyyy')}
                    {p.id === tierUpRowId && (
                      <Badge variant="outline" className="gap-1 text-xs px-1.5 py-0 text-amber-600 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950">
                        <Sparkles className="h-3 w-3" />
                        Tier Up
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-right font-medium">
                  ${p.amount.toLocaleString()}
                </TableCell>
                <TableCell>{statusLabel(p.status)}</TableCell>
                <TableCell>
                  <CleanBadge isClean={p.is_clean_payout} reason={p.clean_payout_reason} status={p.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
