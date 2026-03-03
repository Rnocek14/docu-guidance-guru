import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, MinusCircle, ClipboardCheck } from 'lucide-react';

export function CleanPayoutChecklist() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          What Counts as a Clean Payout?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Counts as clean */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Counts as clean
          </p>
          <Item icon="check" text="Payout fully paid (confirmed by payment provider)" />
          <Item icon="check" text="No active compliance flags at time of payment" />
          <Item icon="check" text="System operating normally (no emergency freeze)" />
        </div>

        {/* Does not count */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Does not count
          </p>
          <Item icon="x" text="Paid while a compliance flag is active on account" />
          <Item icon="x" text="Payout not yet paid (requested, queued, or in review)" />
        </div>

        {/* Neutral */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Neutral (no penalty)
          </p>
          <Item icon="neutral" text="Payout queued by monthly stability budget — paid next window, still eligible for clean" />
        </div>
      </CardContent>
    </Card>
  );
}

function Item({ icon, text }: { icon: 'check' | 'x' | 'neutral'; text: string }) {
  return (
    <div className="flex items-start gap-2">
      {icon === 'check' && <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />}
      {icon === 'x' && <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
      {icon === 'neutral' && <MinusCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />}
      <span className="text-muted-foreground leading-snug">{text}</span>
    </div>
  );
}
