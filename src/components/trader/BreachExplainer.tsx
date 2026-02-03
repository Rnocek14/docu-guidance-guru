import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, XCircle, Clock, Info } from 'lucide-react';
import { format } from 'date-fns';

interface Violation {
  id: string;
  rule_type: string;
  rule_threshold: number | null;
  actual_value: number | null;
  description: string;
  detected_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmation_notes: string | null;
}

interface BreachExplainerProps {
  violations: Violation[];
  accountStatus: string;
}

const ruleTypeLabels: Record<string, string> = {
  max_daily_loss: 'Maximum Daily Loss',
  max_total_drawdown: 'Maximum Total Drawdown',
  max_position_size: 'Maximum Position Size',
  min_trading_days: 'Minimum Trading Days',
};

function getNextSteps(accountStatus: string): string {
  switch (accountStatus) {
    case 'breached_detected':
      return 'Your account is under review. A human reviewer will confirm this breach. No automated action has been taken.';
    case 'under_review':
      return 'Your account is currently being reviewed by our team. You will be notified of the outcome.';
    case 'failed_confirmed':
      return 'This breach has been confirmed by our review team. Your challenge has ended.';
    default:
      return 'Please contact support if you have questions about this violation.';
  }
}

export function BreachExplainer({ violations, accountStatus }: BreachExplainerProps) {
  if (!violations || violations.length === 0) {
    return null;
  }

  const isConfirmed = accountStatus === 'failed_confirmed';
  const isPending = accountStatus === 'breached_detected' || accountStatus === 'under_review';

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-destructive">
            {isConfirmed ? (
              <XCircle className="h-5 w-5" />
            ) : (
              <AlertTriangle className="h-5 w-5" />
            )}
            {isConfirmed ? 'Challenge Failed' : 'Breach Detected'}
          </CardTitle>
          <Badge variant={isConfirmed ? 'destructive' : 'outline'}>
            {isConfirmed ? 'Confirmed' : 'Pending Review'}
          </Badge>
        </div>
        <CardDescription>
          {isConfirmed
            ? 'Your challenge has ended due to a rule violation'
            : 'A potential rule violation was detected on your account'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Violations list */}
        <div className="space-y-3">
          {violations.map((violation) => (
            <div
              key={violation.id}
              className="p-4 rounded-lg border border-destructive/30 bg-destructive/5 space-y-2"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">
                    {ruleTypeLabels[violation.rule_type] || violation.rule_type}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {violation.description}
                  </p>
                </div>
                {violation.confirmed_at && (
                  <Badge variant="destructive" className="text-xs shrink-0">
                    Confirmed
                  </Badge>
                )}
              </div>

              {/* Show the breach values */}
              {violation.actual_value !== null && violation.rule_threshold !== null && (
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Your value:</span>
                    <span className="font-mono font-bold text-destructive">
                      {violation.actual_value.toFixed(2)}%
                    </span>
                  </div>
                  <span className="text-muted-foreground">{'>'}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Limit:</span>
                    <span className="font-mono">
                      {violation.rule_threshold.toFixed(2)}%
                    </span>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Detected {format(new Date(violation.detected_at), 'MMM d, yyyy \'at\' h:mm a')}
              </p>

              {violation.confirmation_notes && (
                <div className="mt-2 p-2 bg-muted rounded text-sm">
                  <p className="font-medium text-xs text-muted-foreground mb-1">Review Notes:</p>
                  <p>{violation.confirmation_notes}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Next steps */}
        {isPending && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>What happens next?</AlertTitle>
            <AlertDescription>{getNextSteps(accountStatus)}</AlertDescription>
          </Alert>
        )}

        {/* Transparency note */}
        <p className="text-xs text-muted-foreground border-t pt-4">
          <strong>Transparency:</strong> All breach detections are logged immutably. 
          Final decisions require human confirmation — no automated account locks or denials.
        </p>
      </CardContent>
    </Card>
  );
}
