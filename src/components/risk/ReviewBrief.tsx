import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, AlertTriangle, TrendingUp, Calendar, Clock, Activity } from 'lucide-react';
import { format, differenceInDays, formatDistanceToNow } from 'date-fns';

interface RuleSnapshot {
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
}

interface Violation {
  id: string;
  rule_type: string;
  rule_threshold: number | null;
  actual_value: number | null;
  description: string;
  detected_at: string;
}

interface ReviewBriefProps {
  account: {
    id: string;
    account_number: string;
    status: string;
    current_balance: number;
    starting_balance: number;
    highest_balance: number;
    total_pnl: number;
    daily_pnl: number;
    trading_days_count: number;
    created_at: string;
    last_trade_at?: string | null;
    rule_snapshot: RuleSnapshot | null;
  };
  violations: Violation[];
  flagsCount: number;
  lastEventAt?: string | null;
}

export function ReviewBrief({ account, violations, flagsCount, lastEventAt }: ReviewBriefProps) {
  const ruleSnapshot = account.rule_snapshot;
  const accountAge = differenceInDays(new Date(), new Date(account.created_at));
  
  // Recency calculations
  const lastTradeRecency = account.last_trade_at 
    ? formatDistanceToNow(new Date(account.last_trade_at), { addSuffix: true })
    : 'Never';
  const lastEventRecency = lastEventAt
    ? formatDistanceToNow(new Date(lastEventAt), { addSuffix: true })
    : 'No events';
  
  // Calculate metrics
  const drawdownPercent = ((account.highest_balance - account.current_balance) / account.highest_balance) * 100;
  const pnlPercent = (account.total_pnl / account.starting_balance) * 100;
  const dailyLossPercent = Math.abs(Math.min(0, (account.daily_pnl / account.starting_balance) * 100));
  
  // Determine breach severity and recommended action
  const hasDeterministicBreach = violations.some(v => 
    ['max_daily_loss', 'max_total_drawdown'].includes(v.rule_type)
  );
  
  // Generate recommendation (SUMMARY ONLY - no automatic action)
  let recommendation: { text: string; severity: 'high' | 'medium' | 'low' } | null = null;
  
  if (hasDeterministicBreach) {
    const breachViolation = violations.find(v => 
      ['max_daily_loss', 'max_total_drawdown'].includes(v.rule_type)
    );
    if (breachViolation && breachViolation.actual_value !== null && breachViolation.rule_threshold !== null) {
      const exceedBy = breachViolation.actual_value - breachViolation.rule_threshold;
      recommendation = {
        text: `Deterministic breach: ${breachViolation.rule_type} exceeded by ${exceedBy.toFixed(2)}%. Evidence is clear.`,
        severity: 'high',
      };
    }
  } else if (flagsCount > 0) {
    recommendation = {
      text: `${flagsCount} pending flag(s) require review. Check flag details for context.`,
      severity: 'medium',
    };
  }

  // Per-case context: WHY this specific account is in review, and what to check.
  const why: string[] = [];
  const checks: string[] = [];
  const discrepancies: string[] = [];

  if (account.status === 'breached_detected') {
    why.push('The rule engine detected a hard-rule breach and paused trading. Money/tier changes are blocked until you confirm or reverse.');
    checks.push('Confirm the breach is real (not bad market data, vendor outage, or stale tick).');
    checks.push('Compare violation actual vs threshold below — if margin is tiny, double-check the data source.');
  } else if (account.status === 'under_review') {
    why.push('A human placed this account on hold. It does not auto-resolve — it sits here until you clear it or escalate.');
    checks.push('Read the timeline for the original reason it was paused.');
    checks.push('Check open flags and recent trades for the behavior that triggered the hold.');
  } else if (account.status === 'payout_requested' || account.status === 'payout_under_review') {
    why.push('Trader submitted a withdrawal. System pre-screened it (rules, reserve, breaker, fraud) — your job is the final yes/no before money leaves.');
    checks.push('Verify rule snapshot was honored across the full account lifetime.');
    checks.push('Confirm no pending flags or recent suspicious activity since the last clean payout.');
  } else if (flagsCount > 0) {
    why.push(`${flagsCount} pending flag(s) raised by the system. Advisory only — trading still active — but must be cleared before next payout/tier-up.`);
    checks.push('Open each flag, read its reason and evidence, then resolve (false positive), acknowledge, or escalate.');
  }

  // Discrepancy heuristics — surface anything that looks "off"
  if (drawdownPercent > 8) {
    discrepancies.push(`Drawdown ${drawdownPercent.toFixed(2)}% is elevated (>8%) — verify against rule limit before approving anything.`);
  }
  if (ruleSnapshot && drawdownPercent > ruleSnapshot.max_total_drawdown_percent) {
    discrepancies.push(`Drawdown ${drawdownPercent.toFixed(2)}% exceeds snapshot limit ${ruleSnapshot.max_total_drawdown_percent}% — likely breach even if not yet flagged.`);
  }
  // Only trust daily_pnl if there was actually a trade today — otherwise it's stale
  // (daily_pnl is reset at the 5pm ET boundary by cron; without recent trades the value is meaningless).
  const tradedToday = account.last_trade_at
    ? differenceInDays(new Date(), new Date(account.last_trade_at)) === 0
    : false;
  if (tradedToday && ruleSnapshot && dailyLossPercent > ruleSnapshot.max_daily_loss_percent) {
    discrepancies.push(`Today's loss ${dailyLossPercent.toFixed(2)}% exceeds daily-loss limit ${ruleSnapshot.max_daily_loss_percent}% — check if a violation is missing.`);
  }
  if (account.trading_days_count === 0 && (account.status === 'payout_requested' || account.status === 'payout_under_review')) {
    discrepancies.push('Payout requested with 0 recorded trading days — investigate before approving.');
  }
  if (ruleSnapshot && account.trading_days_count < ruleSnapshot.min_trading_days && (account.status === 'payout_requested' || account.status === 'payout_under_review')) {
    discrepancies.push(`Trading days ${account.trading_days_count} below min ${ruleSnapshot.min_trading_days} for payout eligibility.`);
  }
  if (account.last_trade_at) {
    const daysSinceTrade = differenceInDays(new Date(), new Date(account.last_trade_at));
    if (daysSinceTrade > 14) {
      discrepancies.push(`No trades in ${daysSinceTrade} days — account may be dormant; verify intent.`);
    }
  }
  if (violations.length === 0 && account.status === 'breached_detected') {
    discrepancies.push('Status is breached_detected but no violations recorded — data inconsistency, investigate before action.');
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Info className="h-4 w-4" />
              Review Brief
            </CardTitle>
            <CardDescription className="text-xs">
              AI-generated summary — final decision by human
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            Auto-generated
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* WHY this case is in review */}
        {why.length > 0 && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Why you're reviewing this</p>
            {why.map((w, i) => (
              <p key={i} className="text-xs text-foreground/90">{w}</p>
            ))}
            {checks.length > 0 && (
              <div className="pt-1">
                <p className="text-xs font-medium text-muted-foreground mb-1">What to check:</p>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-foreground/90">
                  {checks.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Discrepancies — anything that looks "off" */}
        {discrepancies.length > 0 && (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-xs space-y-1">
              <p className="font-semibold">Discrepancies detected:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {discrepancies.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Account Summary */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Age:</span>
            <span className="font-medium">{accountAge} days</span>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Trading days:</span>
            <span className="font-medium">{account.trading_days_count}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Total P&L:</span>
            <span className={`font-medium ${account.total_pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
              {pnlPercent.toFixed(2)}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Drawdown:</span>
            <span className={`font-medium ${drawdownPercent > 8 ? 'text-destructive' : ''}`}>
              {drawdownPercent.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Recency info */}
        <div className="flex items-center gap-4 p-2 bg-muted/30 rounded text-xs">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Last trade:</span>
            <span className="font-medium">{lastTradeRecency}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Last event:</span>
            <span className="font-medium">{lastEventRecency}</span>
          </div>
        </div>

        {/* Rule limits from snapshot */}
        {ruleSnapshot && (
          <div className="p-2 bg-muted/50 rounded text-xs space-y-1">
            <p className="font-medium text-muted-foreground">Rule Limits (from snapshot):</p>
            <div className="grid grid-cols-2 gap-1">
              <span>Daily Loss: {ruleSnapshot.max_daily_loss_percent}%</span>
              <span>Total DD: {ruleSnapshot.max_total_drawdown_percent}%</span>
              <span>Profit Target: {ruleSnapshot.profit_target_percent}%</span>
              <span>Min Days: {ruleSnapshot.min_trading_days}</span>
            </div>
          </div>
        )}

        {/* Violations Summary */}
        {violations.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Violations ({violations.length})
            </p>
            <div className="space-y-1">
              {violations.slice(0, 3).map((v) => (
                <div key={v.id} className="text-xs p-2 bg-destructive/10 rounded border border-destructive/20">
                  <span className="font-medium">{v.rule_type}</span>
                  {v.actual_value !== null && v.rule_threshold !== null && (
                    <span className="text-muted-foreground">
                      {' '}— {v.actual_value.toFixed(2)}% vs {v.rule_threshold.toFixed(2)}% limit
                    </span>
                  )}
                </div>
              ))}
              {violations.length > 3 && (
                <p className="text-xs text-muted-foreground">+{violations.length - 3} more</p>
              )}
            </div>
          </div>
        )}

        {/* Recommendation (summary only, not decisioning) */}
        {recommendation && (
          <Alert variant={recommendation.severity === 'high' ? 'destructive' : 'default'} className="py-2">
            <AlertDescription className="text-xs">
              <strong>Summary:</strong> {recommendation.text}
            </AlertDescription>
          </Alert>
        )}

        <p className="text-xs text-muted-foreground border-t pt-2">
          <Clock className="h-3 w-3 inline mr-1" />
          This is an automated summary. All decisions require human confirmation.
        </p>
      </CardContent>
    </Card>
  );
}
