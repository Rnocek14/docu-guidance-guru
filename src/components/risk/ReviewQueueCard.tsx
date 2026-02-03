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
  User
} from 'lucide-react';
import { format } from 'date-fns';

interface QueueAccount {
  id: string;
  account_number: string;
  status: string;
  current_balance: number;
  starting_balance: number;
  total_pnl: number;
  highest_balance: number;
  created_at: string;
  updated_at: string;
  profile?: {
    full_name: string | null;
    email: string;
  };
  flags_count: number;
  violations_count: number;
}

interface ReviewQueueCardProps {
  account: QueueAccount;
  onViewDetails: (accountId: string) => void;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof Clock }> = {
  breached_detected: { label: 'Breach Detected', variant: 'destructive', icon: AlertTriangle },
  under_review: { label: 'Under Review', variant: 'outline', icon: Clock },
  payout_under_review: { label: 'Payout Review', variant: 'secondary', icon: DollarSign },
  payout_requested: { label: 'Payout Requested', variant: 'outline', icon: DollarSign },
};

export function ReviewQueueCard({ account, onViewDetails }: ReviewQueueCardProps) {
  const config = statusConfig[account.status] || statusConfig.under_review;
  const StatusIcon = config.icon;
  
  const drawdownPercent = ((account.highest_balance - account.current_balance) / account.highest_balance) * 100;
  const pnlPercent = (account.total_pnl / account.starting_balance) * 100;

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              {account.profile?.full_name || 'Unknown Trader'}
            </CardTitle>
            <CardDescription className="text-xs">
              Account #{account.account_number} • {account.profile?.email}
            </CardDescription>
          </div>
          <Badge variant={config.variant} className="shrink-0">
            <StatusIcon className="h-3 w-3 mr-1" />
            {config.label}
          </Badge>
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

        {/* Flags and violations count */}
        <div className="flex items-center gap-4 text-sm">
          {account.flags_count > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <Flag className="h-3 w-3" />
              {account.flags_count} pending flag{account.flags_count !== 1 ? 's' : ''}
            </span>
          )}
          {account.violations_count > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {account.violations_count} violation{account.violations_count !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Timestamp and action */}
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-muted-foreground">
            Updated {format(new Date(account.updated_at), 'MMM d, h:mm a')}
          </span>
          <Button size="sm" variant="outline" onClick={() => onViewDetails(account.id)}>
            <Eye className="h-4 w-4 mr-1" />
            Review
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
