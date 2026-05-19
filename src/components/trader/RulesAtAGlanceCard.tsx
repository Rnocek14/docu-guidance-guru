import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, ScrollText, X } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';

interface RulesAtAGlanceCardProps {
  account: Account & { cohort?: Cohort };
}

const DISMISS_KEY_PREFIX = 'meridian.rules-glance.dismissed.';

/**
 * Plain-English rules summary. Collapsible + dismissible per account.
 * Renders only the rules locked at purchase — single source of truth via cohort.
 */
export function RulesAtAGlanceCard({ account }: RulesAtAGlanceCardProps) {
  const dismissKey = `${DISMISS_KEY_PREFIX}${account.id}`;
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setDismissed(localStorage.getItem(dismissKey) === '1');
  }, [dismissKey]);

  const handleDismiss = () => {
    localStorage.setItem(dismissKey, '1');
    setDismissed(true);
  };

  if (dismissed) return null;

  const c = account.cohort;
  const rules: Array<{ label: string; value: string }> = [
    { label: 'Profit target', value: `${c?.profit_target_percent ?? 10}% of starting balance` },
    { label: 'Max daily loss', value: `${c?.max_daily_loss_percent ?? 5}% of starting balance` },
    { label: 'Max drawdown', value: `${c?.max_total_drawdown_percent ?? 10}% trailing EOD floor` },
    { label: 'Min trading days', value: `${c?.min_trading_days ?? 5} days before passing` },
    { label: 'Payout split', value: `80% to you (Starter ladder)` },
    { label: 'First payout cap', value: `Up to $${(c?.first_payout_cap_amount ?? 500).toLocaleString()}` },
    { label: 'Payouts 2+', value: `Uncapped per cycle, up to lifetime cap` },
    { label: 'Cooldown', value: `14 days between payouts` },
    { label: 'Pro tier unlock', value: `3 clean payouts → 85/15 split, higher lifetime cap` },
  ];

  return (
    <Card className="border-primary/20 bg-primary/[0.02]">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 text-left flex-1 group"
          >
            <ScrollText className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-medium group-hover:text-primary transition-colors">
              Your rules at a glance
            </CardTitle>
            {open ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground ml-auto" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" />
            )}
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleDismiss}
            aria-label="Dismiss rules card"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-1">
          <p className="text-xs text-muted-foreground mb-3">
            Rules are locked at purchase and cannot change mid-evaluation.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {rules.map((r) => (
              <div
                key={r.label}
                className="flex items-baseline justify-between gap-3 text-sm border-b border-border/40 pb-1.5 last:border-0"
              >
                <span className="text-muted-foreground">{r.label}</span>
                <span className="text-foreground font-medium text-right">{r.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
