import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Clock, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  DollarSign,
  RefreshCw,
  ArrowRightLeft
} from 'lucide-react';
import { format } from 'date-fns';

interface AccountEvent {
  id: string;
  account_id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
}

interface AccountTimelineProps {
  accountId: string;
  maxHeight?: string;
}

const eventConfig: Record<string, { icon: typeof Clock; color: string; label: string }> = {
  account_created: { icon: CheckCircle, color: 'text-success', label: 'Account Created' },
  trade_ingested: { icon: TrendingUp, color: 'text-primary', label: 'Trade Ingested' },
  daily_reset: { icon: RefreshCw, color: 'text-muted-foreground', label: 'Daily Reset' },
  breach_detected: { icon: AlertTriangle, color: 'text-destructive', label: 'Breach Detected' },
  breach_confirmed: { icon: XCircle, color: 'text-destructive', label: 'Breach Confirmed' },
  failure_confirmed: { icon: XCircle, color: 'text-destructive', label: 'Failure Confirmed' },
  passed: { icon: CheckCircle, color: 'text-success', label: 'Challenge Passed' },
  payout_requested: { icon: DollarSign, color: 'text-primary', label: 'Payout Requested' },
  payout_under_review: { icon: Clock, color: 'text-warning', label: 'Payout Under Review' },
  payout_approved: { icon: CheckCircle, color: 'text-success', label: 'Payout Approved' },
  payout_rejected: { icon: XCircle, color: 'text-destructive', label: 'Payout Rejected' },
  payout_paid: { icon: DollarSign, color: 'text-success', label: 'Payout Paid' },
  status_changed: { icon: ArrowRightLeft, color: 'text-muted-foreground', label: 'Status Changed' },
};

function getEventDetails(event: AccountEvent): string {
  const data = event.event_data;
  
  switch (event.event_type) {
    case 'trade_ingested':
      return `${data.symbol || 'Unknown'} • ${data.side || ''} • P&L: ${data.pnl !== undefined ? `$${Number(data.pnl).toLocaleString()}` : 'N/A'}`;
    case 'breach_detected':
      return `${data.rule_type || 'Rule'} exceeded: ${data.actual_value !== undefined ? `${data.actual_value}%` : ''} > ${data.threshold !== undefined ? `${data.threshold}%` : ''} limit. ${data.explanation || ''}`;
    case 'status_changed':
      return `Status changed from ${data.previous_status || 'unknown'} to ${data.new_status || 'unknown'}`;
    case 'payout_requested':
      return `Amount: $${data.amount ? Number(data.amount).toLocaleString() : 'N/A'}`;
    case 'daily_reset':
      return `New day started. Previous day P&L: $${data.previous_daily_pnl ? Number(data.previous_daily_pnl).toLocaleString() : '0'}`;
    case 'failure_confirmed':
      return data.reason as string || 'Account failed review';
    default:
      return data.message as string || '';
  }
}

export function AccountTimeline({ accountId, maxHeight = '400px' }: AccountTimelineProps) {
  const { data: events, isLoading, error } = useQuery({
    queryKey: ['account-events', accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_events')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as AccountEvent[];
    },
    enabled: !!accountId,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Account Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Account Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load timeline events.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Account Timeline
        </CardTitle>
        <CardDescription>
          Immutable record of all account events
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events && events.length > 0 ? (
          <ScrollArea className="pr-4" style={{ maxHeight }}>
            <div className="relative space-y-1">
              {/* Timeline line */}
              <div className="absolute left-4 top-2 bottom-2 w-px bg-border" />
              
              {events.map((event, index) => {
                const config = eventConfig[event.event_type] || { 
                  icon: Clock, 
                  color: 'text-muted-foreground', 
                  label: event.event_type 
                };
                const Icon = config.icon;
                const details = getEventDetails(event);

                return (
                  <div
                    key={event.id}
                    className={`relative flex gap-4 pb-4 ${index === events.length - 1 ? '' : ''}`}
                  >
                    {/* Icon */}
                    <div className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-background border ${config.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 space-y-1 pt-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{config.label}</span>
                        {event.event_type === 'breach_detected' && (
                          <Badge variant="destructive" className="text-xs">Action Required</Badge>
                        )}
                      </div>
                      {details && (
                        <p className="text-sm text-muted-foreground">{details}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(event.created_at), 'MMM d, yyyy \'at\' h:mm a')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">
            No events recorded yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
