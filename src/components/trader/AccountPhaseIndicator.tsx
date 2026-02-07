import { Badge } from '@/components/ui/badge';
import { Target, CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import type { AccountStatus } from '@/lib/types';
import { format, parseISO, isValid } from 'date-fns';

type CohortPhase = 'evaluation' | 'verification' | 'performance';

interface AccountPhaseIndicatorProps {
  status: AccountStatus;
  profitTargetPercent: number;
  cohortPhase?: CohortPhase;
  payoutWindowOpened?: boolean;
  daysRemaining?: number;
  windowOpensAt?: string | null;
}

const phaseConfig: Record<CohortPhase, { label: string; badge: string; description: string }> = {
  evaluation: {
    label: 'Challenge Phase',
    badge: 'Evaluation',
    description: 'Hit your {target}% performance target to advance.',
  },
  verification: {
    label: 'Verification Phase',
    badge: 'Verification',
    description: 'Demonstrate consistency to unlock your Performance Account.',
  },
  performance: {
    label: 'Performance Account',
    badge: 'PA',
    description: "You've passed! You're eligible to request performance-based payouts.",
  },
};

export function AccountPhaseIndicator({ 
  status, 
  profitTargetPercent,
  cohortPhase = 'evaluation',
  payoutWindowOpened = true,
  daysRemaining,
  windowOpensAt,
}: AccountPhaseIndicatorProps) {
  const isPassedOrPayout = status === 'passed' || status.startsWith('payout_');
  
  // Performance Account in cooling period
  if (cohortPhase === 'performance' && isPassedOrPayout && payoutWindowOpened === false && daysRemaining !== undefined) {
    let formattedDate = 'soon';
    if (windowOpensAt) {
      try {
        const parsed = parseISO(windowOpensAt);
        if (isValid(parsed)) {
          formattedDate = format(parsed, 'MMM d');
        }
      } catch {
        formattedDate = 'soon';
      }
    }
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-warning/20 p-2">
            <Clock className="h-5 w-5 text-warning" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-warning">Payout Window Opening Soon</h3>
              <Badge variant="secondary" className="bg-warning/20 text-warning border-warning/30">
                {daysRemaining} days
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Your eligibility is locked in. Payout window opens {formattedDate}.
            </p>
          </div>
        </div>
      </div>
    );
  }
  
  // Performance Account with window open
  if (cohortPhase === 'performance' && isPassedOrPayout) {
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
              You've passed! You're eligible to request performance-based payouts.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Verification phase (active or passed)
  if (cohortPhase === 'verification') {
    const isPassed = isPassedOrPayout;
    return (
      <div className={`rounded-lg border p-4 ${isPassed ? 'border-success/30 bg-success/10' : 'border-accent/30 bg-accent/10'}`}>
        <div className="flex items-start gap-3">
          <div className={`rounded-full p-2 ${isPassed ? 'bg-success/20' : 'bg-accent/20'}`}>
            <ShieldCheck className={`h-5 w-5 ${isPassed ? 'text-success' : 'text-accent-foreground'}`} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className={`font-semibold ${isPassed ? 'text-success' : 'text-accent-foreground'}`}>
                {isPassed ? 'Verification Complete' : 'Verification Phase'}
              </h3>
              <Badge variant="secondary" className={isPassed ? 'bg-success/20 text-success border-success/30' : 'bg-accent/20 text-accent-foreground border-accent/30'}>
                Verification
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {isPassed
                ? 'You\'ve passed verification! Your Performance Account is being set up.'
                : `Demonstrate consistency with a ${profitTargetPercent}% target to unlock your Performance Account.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Evaluation / Challenge phase (default)
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
            Hit your {profitTargetPercent}% performance target to advance.
          </p>
        </div>
      </div>
    </div>
  );
}
