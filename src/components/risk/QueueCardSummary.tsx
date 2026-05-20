import { DollarSign, AlertTriangle, Flag, Clock } from 'lucide-react';

interface Violation {
  rule_type: string;
  actual_value: number | null;
  rule_threshold: number | null;
}

interface QueueCardSummaryProps {
  status: string;
  violations?: Violation[];
  flagsCount: number;
  payoutAmount?: number;
  // Fallback context — used to infer a breach summary when violations row is missing
  startingBalance?: number;
  currentBalance?: number;
  highestBalance?: number;
  dailyPnl?: number;
  ruleSnapshot?: { max_daily_loss_percent?: number; max_total_drawdown_percent?: number } | null;
}

/**
 * Generates a one-liner summary for queue cards
 * Priority: Payout → Most severe violation → Flags → Default
 */
export function QueueCardSummary({ 
  status, 
  violations = [], 
  flagsCount, 
  payoutAmount,
  startingBalance,
  currentBalance,
  highestBalance,
  dailyPnl,
  ruleSnapshot,
}: QueueCardSummaryProps) {
  // Payout statuses take priority
  if (['payout_requested', 'payout_under_review'].includes(status)) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <DollarSign className="h-3 w-3 text-primary" />
        <span>
          Payout request{payoutAmount ? `: $${payoutAmount.toLocaleString()}` : ''} pending
        </span>
      </div>
    );
  }

  // Show most severe violation if exists
  if (violations.length > 0) {
    const topViolation = pickMostSevereViolation(violations);
    if (topViolation) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" />
          <span>{formatViolationSummary(topViolation)}</span>
        </div>
      );
    }
  }

  // Fallback: status says breach but no violation row — derive from balances + snapshot
  if (status === 'breached_detected' && startingBalance && currentBalance != null && highestBalance != null) {
    const ddPct = ((highestBalance - currentBalance) / highestBalance) * 100;
    const dailyLossPct = Math.abs(Math.min(0, ((dailyPnl ?? 0) / startingBalance) * 100));
    const ddLimit = ruleSnapshot?.max_total_drawdown_percent ?? 10;
    const dlLimit = ruleSnapshot?.max_daily_loss_percent ?? 5;

    if (ddPct >= ddLimit) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" />
          <span>Total drawdown: {ddPct.toFixed(2)}% (limit {ddLimit.toFixed(2)}%) — inferred</span>
        </div>
      );
    }
    if (dailyLossPct >= dlLimit) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" />
          <span>Daily loss: {dailyLossPct.toFixed(2)}% (limit {dlLimit.toFixed(2)}%) — inferred</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-xs text-warning">
        <AlertTriangle className="h-3 w-3" />
        <span>Breach status set but no violation row — investigate</span>
      </div>
    );
  }

  // Show flags count
  if (flagsCount > 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-warning">
        <Flag className="h-3 w-3" />
        <span>{flagsCount} flag{flagsCount !== 1 ? 's' : ''} pending — needs review</span>
      </div>
    );
  }

  // Default
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="h-3 w-3" />
      <span>Under review</span>
    </div>
  );
}

/**
 * Severity order: total drawdown > daily loss > other
 */
function pickMostSevereViolation(violations: Violation[]): Violation | null {
  if (violations.length === 0) return null;

  // Check for total drawdown first (most severe)
  const drawdown = violations.find(v => 
    v.rule_type === 'max_total_drawdown' || 
    v.rule_type === 'total_drawdown' || 
    v.rule_type === 'max_drawdown'
  );
  if (drawdown) return drawdown;

  // Then daily loss
  const dailyLoss = violations.find(v => 
    v.rule_type === 'max_daily_loss' || 
    v.rule_type === 'daily_loss'
  );
  if (dailyLoss) return dailyLoss;

  // Return first violation as fallback
  return violations[0];
}

/**
 * Format violation into human-readable summary
 */
function formatViolationSummary(violation: Violation): string {
  const { rule_type, actual_value, rule_threshold } = violation;

  const ruleLabels: Record<string, string> = {
    'max_total_drawdown': 'Total drawdown breach',
    'total_drawdown': 'Total drawdown breach',
    'max_drawdown': 'Total drawdown breach',
    'max_daily_loss': 'Daily loss breach',
    'daily_loss': 'Daily loss breach',
    'max_position_size': 'Position size breach',
    'min_trading_days': 'Trading days requirement',
  };

  const label = ruleLabels[rule_type] || `${rule_type} breach`;

  if (actual_value !== null && rule_threshold !== null) {
    // Format as percentage for loss/drawdown rules
    if (rule_type.includes('loss') || rule_type.includes('drawdown')) {
      return `${label}: ${actual_value.toFixed(2)}% (limit ${rule_threshold.toFixed(2)}%)`;
    }
    return `${label}: ${actual_value} (limit ${rule_threshold})`;
  }

  return label;
}
