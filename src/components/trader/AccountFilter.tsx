import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface AccountOption {
  id: string;
  account_number: string;
  cohort_phase?: string;
  status: string;
}

interface AccountFilterProps {
  accounts: AccountOption[];
  value: string; // 'all' or account ID
  onChange: (value: string) => void;
}

const PHASE_LABELS: Record<string, string> = {
  evaluation: 'Eval',
  verification: 'Veri',
  performance: 'PA',
};

const STATUS_DOT: Record<string, string> = {
  active: 'bg-success',
  passed: 'bg-primary',
  failed_confirmed: 'bg-destructive',
  breached_detected: 'bg-destructive',
};

export function AccountFilter({ accounts, value, onChange }: AccountFilterProps) {
  if (accounts.length <= 1) return null;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[220px]">
        <SelectValue placeholder="All Accounts" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Accounts</SelectItem>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <span className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full inline-block', STATUS_DOT[a.status] || 'bg-muted-foreground')} />
              <span className="font-mono text-xs">#{a.account_number}</span>
              {a.cohort_phase && (
                <span className="text-[10px] text-muted-foreground">
                  {PHASE_LABELS[a.cohort_phase] || a.cohort_phase}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
