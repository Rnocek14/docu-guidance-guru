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
