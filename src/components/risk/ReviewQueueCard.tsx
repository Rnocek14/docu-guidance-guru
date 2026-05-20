import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  AlertTriangle, 
  Clock, 
  DollarSign, 
  Eye, 
  Flag,
  TrendingDown,
  User,
  Activity
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { getPriorityLabel } from '@/lib/queue-priority';
import { cn } from '@/lib/utils';
import { QueueCardSummary } from './QueueCardSummary';
import { QueueCardActions } from './QueueCardActions';

interface Violation {
  rule_type: string;
  actual_value: number | null;
  rule_threshold: number | null;
}

interface QueueAccount {
  id: string;
  account_number: string;
  status: string;
  current_balance: number;
  starting_balance: number;
  total_pnl: number;
  highest_balance: number;
  daily_pnl?: number;
  rule_snapshot?: { max_daily_loss_percent?: number; max_total_drawdown_percent?: number } | null;
  created_at: string;
  updated_at: string;
  last_trade_at?: string | null;
  last_event_at?: string | null;
  profile?: {
    full_name: string | null;
    email: string;
  };
  flags_count: number;
  violations_count: number;
  violations?: Violation[];
  payout_amount?: number;
  single_flag_id?: string | null;
}

interface ReviewQueueCardProps {
  account: QueueAccount;
  onViewDetails: (accountId: string) => void;
  onActionComplete?: () => void;
  isSelected?: boolean;
  priorityScore?: number;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof Clock }> = {
  breached_detected: { label: 'Breach Detected', variant: 'destructive', icon: AlertTriangle },
  under_review: { label: 'Under Review', variant: 'outline', icon: Clock },
  payout_under_review: { label: 'Payout Review', variant: 'secondary', icon: DollarSign },
  payout_requested: { label: 'Payout Requested', variant: 'outline', icon: DollarSign },
};

export function ReviewQueueCard({ account, onViewDetails, onActionComplete, isSelected, priorityScore }: ReviewQueueCardProps) {
  const config = statusConfig[account.status] || statusConfig.under_review;
  const StatusIcon = config.icon;
  
  const drawdownPercent = ((account.highest_balance - account.current_balance) / account.highest_balance) * 100;
  const pnlPercent = (account.total_pnl / account.starting_balance) * 100;

  // Get priority label for display
  const priority = priorityScore !== undefined ? getPriorityLabel(priorityScore) : null;
  
  // Calculate recency display
  const lastActivity = account.last_event_at || account.last_trade_at || account.updated_at;
  const recencyText = formatDistanceToNow(new Date(lastActivity), { addSuffix: true });

  return (
    <Card 
      className={cn(
        "hover:border-primary/50 transition-colors cursor-pointer",
        isSelected && "ring-2 ring-primary border-primary"
      )}
      data-queue-card
      onClick={() => onViewDetails(account.id)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{account.profile?.full_name || 'Unknown Trader'}</span>
            </CardTitle>
            <CardDescription className="text-xs flex items-center gap-2 flex-wrap">
              <span>#{account.account_number}</span>
              {priority && (
                <Badge variant={priority.variant} className="text-[10px] px-1.5 py-0">
                  {priority.label}
                </Badge>
              )}
              <span className="flex items-center gap-1 text-muted-foreground">
                <Activity className="h-3 w-3" />
                {recencyText}
              </span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Badge variant={config.variant}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {config.label}
            </Badge>
            <QueueCardActions
              accountId={account.id}
              accountNumber={account.account_number}
              accountStatus={account.status}
              flagsCount={account.flags_count}
              singleFlagId={account.single_flag_id}
              onActionComplete={onActionComplete}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Metrics */}
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Balance</p>
            <p className="font-medium">${account.current_balance.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">P&L</p>
            <p className={`font-medium ${account.total_pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
              {account.total_pnl >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Drawdown</p>
            <p className={`font-medium flex items-center gap-1 ${drawdownPercent > 8 ? 'text-destructive' : ''}`}>
              <TrendingDown className="h-3 w-3" />
              {drawdownPercent.toFixed(2)}%
            </p>
          </div>
        </div>

        {/* Inline summary - the one-liner */}
        <QueueCardSummary
          status={account.status}
          violations={account.violations}
          flagsCount={account.flags_count}
          payoutAmount={account.payout_amount}
          startingBalance={account.starting_balance}
          currentBalance={account.current_balance}
          highestBalance={account.highest_balance}
          dailyPnl={account.daily_pnl}
          ruleSnapshot={account.rule_snapshot}
        />

        {/* Timestamp and action */}
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-muted-foreground">
            Updated {format(new Date(account.updated_at), 'MMM d, h:mm a')}
          </span>
          <Button 
            size="sm" 
            variant="outline" 
            onClick={(e) => {
              e.stopPropagation();
              onViewDetails(account.id);
            }}
          >
            <Eye className="h-4 w-4 mr-1" />
            Review
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
