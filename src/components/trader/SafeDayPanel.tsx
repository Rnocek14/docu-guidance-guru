import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Account, Cohort } from '@/lib/types';

interface SafeDayPanelProps {
  account: Account & { cohort: Cohort };
}

type RiskBand = 'low' | 'medium' | 'high';
type TightRail = 'drawdown' | 'daily_loss' | 'both';

const BAND_CONFIG: Record<RiskBand, { label: string; badgeVariant: 'default' | 'outline' | 'destructive'; description: string }> = {
  low: {
    label: 'Low Risk',
    badgeVariant: 'default',
    description: 'You have comfortable headroom. Normal trading activity is unlikely to trigger a breach.',
  },
  medium: {
    label: 'Medium Risk',
    badgeVariant: 'outline',
    description: 'Headroom is tightening. Consider smaller position sizes to protect your progress.',
  },
  high: {
    label: 'High Risk',
    badgeVariant: 'destructive',
    description: 'Very limited headroom remaining. Large swings could trigger a breach.',
  },
};

const RAIL_LABELS: Record<TightRail, string> = {
  drawdown: 'Drawdown headroom is your tightest rail today.',
  daily_loss: 'Daily loss limit is your tightest rail today.',
  both: 'Both rails are equally tight today.',
};

export function SafeDayPanel({ account }: SafeDayPanelProps) {
  const ackKey = `risk_ack:${account.id}:${new Date().toISOString().slice(0, 10)}`;
  const [acknowledged, setAcknowledged] = useState(() => {
    try { return localStorage.getItem(ackKey) === '1'; } catch { return false; }
  });
  const [showAckDialog, setShowAckDialog] = useState(false);

  const analysis = useMemo(() => {
    const profitTarget = account.cohort?.profit_target_percent ?? 10;
    const minTradingDays = account.cohort?.min_trading_days ?? 5;
    const maxDailyLossPct = account.cohort?.max_daily_loss_percent ?? 5;

    const currentReturn = (account.total_pnl / account.starting_balance) * 100;
    const targetMet = currentReturn >= profitTarget;
    const daysMet = account.trading_days_count >= minTradingDays;

    const dailyLossLimit = account.starting_balance * (maxDailyLossPct / 100);

    const maxDrawdownPct = account.cohort?.max_total_drawdown_percent ?? 10;
    const drawdownFloor = account.highest_balance * (1 - maxDrawdownPct / 100);
    const drawdownHeadroom = Math.max(0, account.current_balance - drawdownFloor);

    // Determine which rail is the tighter constraint
    const minRail = Math.min(drawdownHeadroom, dailyLossLimit);
    const maxRail = Math.max(drawdownHeadroom, dailyLossLimit);
    const railRatio = maxRail > 0 ? minRail / maxRail : 1;
    let tightRail: TightRail;
    if (railRatio >= 0.95) {
      tightRail = 'both';
    } else if (drawdownHeadroom < dailyLossLimit) {
      tightRail = 'drawdown';
    } else {
      tightRail = 'daily_loss';
    }

    const safeDaySize = Math.min(dailyLossLimit, drawdownHeadroom);

    // Compute risk band based on headroom ratio (safeDaySize / dailyLossLimit)
    const headroomRatio = dailyLossLimit > 0 ? safeDaySize / dailyLossLimit : 0;
    let riskBand: RiskBand;
    if (headroomRatio >= 0.6) {
      riskBand = 'low';
    } else if (headroomRatio >= 0.3) {
      riskBand = 'medium';
    } else {
      riskBand = 'high';
    }

    return {
      targetMet,
      daysMet,
      riskBand,
      tightRail,
      allMet: targetMet && daysMet,
    };
  }, [account]);

  const bandConfig = BAND_CONFIG[analysis.riskBand];

  const checks = [
    { label: 'Min trading days', met: analysis.daysMet },
    { label: 'Profit target', met: analysis.targetMet },
  ];

  const showHighRiskOverlay = analysis.riskBand === 'high' && !acknowledged;

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Review Readiness Snapshot
          </CardTitle>
          <CardDescription>Where you stand if you stop trading today</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-sm">
                {c.met ? (
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                )}
                <span className={c.met ? 'text-foreground' : 'text-muted-foreground'}>{c.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Session risk level
              </div>
              <Badge variant={bandConfig.badgeVariant} className="text-xs">
                {bandConfig.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {bandConfig.description}
            </p>
            {/* Which rail is tighter */}
            <p className="text-xs text-muted-foreground/70 italic">
              {RAIL_LABELS[analysis.tightRail]}
            </p>
          </div>

          {/* High risk friction */}
          {showHighRiskOverlay && (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">Protect your progress</p>
                  <p className="text-xs text-muted-foreground">
                    Your headroom is very limited. Trading in this zone significantly increases your risk of a breach. Take a moment to consider whether entering a new position is worth the risk to your account.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => setShowAckDialog(true)}
              >
                I understand the risk
              </Button>
            </div>
          )}

          {analysis.allMet && (
            <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success font-medium">
              All milestones met — qualifying for staff review.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Acknowledgment dialog */}
      <Dialog open={showAckDialog} onOpenChange={setShowAckDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              High Risk Acknowledgment
            </DialogTitle>
            <DialogDescription>
              Your account has very limited headroom before a breach. Continuing to trade in this zone increases the likelihood of losing your progress.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowAckDialog(false)}>
              Go back
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setAcknowledged(true);
                try { localStorage.setItem(ackKey, '1'); } catch {}
                setShowAckDialog(false);
              }}
            >
              I understand, dismiss warning
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
