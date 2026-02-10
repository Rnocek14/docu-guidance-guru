import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Compass, CheckCircle2, Circle, Calendar, Target, Send, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Account, Cohort } from '@/lib/types';

interface WhatsNextCardProps {
  account: Account & { cohort: Cohort };
}

export function WhatsNextCard({ account }: WhatsNextCardProps) {
  const analysis = useMemo(() => {
    const profitTarget = account.cohort?.profit_target_percent ?? 10;
    const minTradingDays = account.cohort?.min_trading_days ?? 5;

    const currentReturn = (account.total_pnl / account.starting_balance) * 100;
    const remainingPercent = Math.max(0, profitTarget - currentReturn);
    const remainingDollars = Math.max(0, (remainingPercent / 100) * account.starting_balance);

    const daysCompleted = account.trading_days_count;
    const daysRemaining = Math.max(0, minTradingDays - daysCompleted);

    const targetMet = currentReturn >= profitTarget;
    const daysMet = daysCompleted >= minTradingDays;

    const avgDailyPnl = daysCompleted > 0 ? account.total_pnl / daysCompleted : 0;
    const estimatedDaysToTarget = avgDailyPnl > 0 && !targetMet
      ? Math.ceil(remainingDollars / avgDailyPnl)
      : null;

    return {
      currentReturn,
      profitTarget,
      remainingPercent,
      remainingDollars,
      daysCompleted,
      minTradingDays,
      daysRemaining,
      targetMet,
      daysMet,
      estimatedDaysToTarget,
      avgDailyPnl,
      allMet: targetMet && daysMet,
    };
  }, [account]);

  const milestones = [
    {
      label: 'Minimum trading days',
      done: analysis.daysMet,
      detail: analysis.daysMet
        ? 'Trading days requirement met'
        : 'Additional trading days needed',
    },
    {
      label: 'Profit target',
      done: analysis.targetMet,
      detail: analysis.targetMet
        ? 'Target reached'
        : 'Still working toward the target — keep trading consistently',
    },
    {
      label: 'Staff review of results',
      done: false,
      detail: 'All transitions are human-reviewed before proceeding',
    },
  ];

  // Contextual next action
  const nextAction = useMemo(() => {
    if (!analysis.daysMet) {
      return {
        icon: Calendar,
        text: 'Continue trading to meet the minimum days requirement',
      };
    }
    if (!analysis.targetMet) {
      return {
        icon: Target,
        text: 'Keep trading consistently toward your profit target',
      };
    }
    return {
      icon: Send,
      text: 'All milestones met — your account will be reviewed by staff',
    };
  }, [analysis]);

  const NextIcon = nextAction.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Compass className="h-5 w-5 text-primary" />
          What Happens Next
        </CardTitle>
        <CardDescription>Your path through this evaluation phase</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {milestones.map((m, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="mt-0.5">
                {m.done ? (
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${m.done ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {m.label}
                </div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Contextual next action */}
        <div className={`mt-4 rounded-lg border p-3 ${
          analysis.allMet 
            ? 'border-success/30 bg-success/5' 
            : 'border-border bg-muted/30'
        }`}>
          <div className="flex items-center gap-2 text-sm">
            <NextIcon className={`h-4 w-4 shrink-0 ${
              analysis.allMet ? 'text-success' : 'text-primary'
            }`} />
            <span className={analysis.allMet ? 'font-medium text-foreground' : 'text-muted-foreground'}>
              {nextAction.text}
            </span>
          </div>

          {/* Pace indicator (qualitative, not quantitative) */}
          {!analysis.targetMet && analysis.avgDailyPnl !== 0 && (
            <p className="text-xs text-muted-foreground/70 mt-2 ml-6">
              Your current pace is {analysis.avgDailyPnl > 0 ? 'positive — keep trading consistently' : 'negative — consider adjusting your approach'}.
            </p>
          )}
        </div>

        {/* CTA button */}
        <div className="mt-3">
          {analysis.allMet ? (
            <Button asChild size="sm" className="w-full gap-2">
              <Link to={`/trader/accounts/${account.id}`}>
                <Send className="h-3.5 w-3.5" />
                View Account for Review
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className="w-full gap-2">
              <Link to={`/trader/accounts/${account.id}`}>
                <ExternalLink className="h-3.5 w-3.5" />
                View Full Account Details
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
