import { Badge } from '@/components/ui/badge';
import { Target, CheckCircle2 } from 'lucide-react';
import type { AccountStatus } from '@/lib/types';

interface AccountPhaseIndicatorProps {
  status: AccountStatus;
  profitTargetPercent: number;
}

export function AccountPhaseIndicator({ status, profitTargetPercent }: AccountPhaseIndicatorProps) {
  const isPerformanceAccount = status === 'passed' || status.startsWith('payout_');
  
  if (isPerformanceAccount) {
    return (
      <div className="rounded-lg border border-success/30 bg-success/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-success/20 p-2">
            <CheckCircle2 className="h-5 w-5 text-success" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-success">Performance Account</h3>
              <Badge variant="secondary" className="bg-success/20 text-success border-success/30">
                PA
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              You've passed! Request payouts from your profits.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/10 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-primary/20 p-2">
          <Target className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-primary">Challenge Phase</h3>
            <Badge variant="secondary" className="bg-primary/20 text-primary border-primary/30">
              Evaluation
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Hit your {profitTargetPercent}% profit target to unlock your Performance Account.
          </p>
        </div>
      </div>
    </div>
  );
}
