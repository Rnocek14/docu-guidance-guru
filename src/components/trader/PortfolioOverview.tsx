import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DollarSign, TrendingUp, BarChart3, Wallet } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';

interface PortfolioOverviewProps {
  accounts: (Account & { cohort: Cohort })[];
  totalPaidOut?: number;
}

export function PortfolioOverview({ accounts, totalPaidOut = 0 }: PortfolioOverviewProps) {
  const statusCounts = accounts.reduce(
    (acc, a) => {
      if (a.status === 'active') acc.active++;
      else if (a.status === 'passed' || a.status.startsWith('payout_')) acc.passed++;
      else if (a.status === 'failed_confirmed' || a.status === 'breached_detected') acc.failed++;
      else acc.other++;
      return acc;
    },
    { active: 0, passed: 0, failed: 0, other: 0 },
  );

  const phaseCounts = accounts.reduce(
    (acc, a) => {
      const phase = a.cohort?.cohort_phase || 'evaluation';
      acc[phase] = (acc[phase] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const totalBalance = accounts
    .filter((a) => a.status === 'active' || a.status === 'passed' || a.status.startsWith('payout_'))
    .reduce((sum, a) => sum + a.current_balance, 0);

  const totalPnl = accounts.reduce((sum, a) => sum + a.total_pnl, 0);

  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      {/* Accounts */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Card className="cursor-default">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">Accounts</CardTitle>
                <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
              </CardHeader>
              <CardContent className="pb-3">
                <div className="text-xl font-bold">{accounts.length}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {statusCounts.active > 0 && (
                    <Badge variant="default" className="text-[10px] px-1.5 py-0">
                      {statusCounts.active} Active
                    </Badge>
                  )}
                  {statusCounts.passed > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {statusCounts.passed} Passed
                    </Badge>
                  )}
                  {statusCounts.failed > 0 && (
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                      {statusCounts.failed} Failed
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs space-y-0.5">
              {Object.entries(phaseCounts).map(([phase, count]) => (
                <div key={phase} className="capitalize">
                  {phase}: {count}
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Combined Balance */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground">Combined Balance</CardTitle>
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent className="pb-3">
          <div className="text-xl font-bold">${totalBalance.toLocaleString()}</div>
          <p className="text-[10px] text-muted-foreground">Active + passed accounts</p>
        </CardContent>
      </Card>

      {/* Lifetime P&L */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground">Lifetime P&L</CardTitle>
          <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent className="pb-3">
          <div className={`text-xl font-bold ${totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}
          </div>
          <p className="text-[10px] text-muted-foreground">Across all accounts</p>
        </CardContent>
      </Card>

      {/* Total Payouts */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-xs font-medium text-muted-foreground">Total Payouts</CardTitle>
          <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent className="pb-3">
          <div className="text-xl font-bold text-success">
            ${totalPaidOut.toLocaleString()}
          </div>
          <p className="text-[10px] text-muted-foreground">Lifetime received</p>
        </CardContent>
      </Card>
    </div>
  );
}
