import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface QaResult {
  result: 'PASS' | 'FAIL';
  assertions: Record<string, boolean>;
  payout_id: string;
  account_number: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  payout_actions_response?: unknown;
}

export function QaApprovePanel() {
  const [selectedPayout, setSelectedPayout] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [qaResult, setQaResult] = useState<QaResult | null>(null);

  // Fetch eligible SEEDV2/DEMO payouts
  const { data: eligiblePayouts } = useQuery({
    queryKey: ['qa-eligible-payouts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payouts')
        .select('id, status, amount, accounts!inner(account_number)')
        .in('status', ['pending', 'under_review'])
        .or('account_number.like.SEEDV2-%,account_number.like.DEMO-%', { referencedTable: 'accounts' });

      if (error) throw error;
      return (data ?? []).map((p) => ({
        id: p.id,
        status: p.status,
        amount: Number(p.amount),
        account_number: (Array.isArray(p.accounts) ? p.accounts[0] : p.accounts)?.account_number ?? 'unknown',
      }));
    },
  });

  const runQaApprove = async () => {
    if (!selectedPayout) {
      toast.error('Select a payout first');
      return;
    }

    setRunning(true);
    setQaResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Not authenticated – log in as admin first');
        return;
      }

      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/qa-approve-payout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ payout_id: selectedPayout }),
      });

      const body = await res.json();

      if (!res.ok) {
        toast.error(body.error || 'QA function failed');
        setQaResult(body);
        return;
      }

      setQaResult(body);
      if (body.result === 'PASS') {
        toast.success('QA Approve Test: PASS ✅');
      } else {
        toast.warning('QA Approve Test: FAIL — check assertions');
      }
    } catch (err) {
      toast.error('Network error: ' + String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="border-muted">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="h-4 w-4" />
          QA: Payout Approval Test
        </CardTitle>
        <CardDescription>
          Runs the full production approval path (payout-actions) on a SEEDV2/DEMO payout and asserts DB state.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Select value={selectedPayout} onValueChange={setSelectedPayout}>
              <SelectTrigger>
                <SelectValue placeholder="Select a payout..." />
              </SelectTrigger>
              <SelectContent>
                {(eligiblePayouts ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.account_number} — ${p.amount} ({p.status})
                  </SelectItem>
                ))}
                {(eligiblePayouts ?? []).length === 0 && (
                  <SelectItem value="__none" disabled>No eligible payouts</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={runQaApprove} disabled={running || !selectedPayout} size="sm">
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FlaskConical className="h-4 w-4 mr-1" />}
            Run Test
          </Button>
        </div>

        {qaResult && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {qaResult.result === 'PASS' ? (
                <Badge variant="default" className="bg-green-600"><CheckCircle2 className="h-3 w-3 mr-1" />PASS</Badge>
              ) : (
                <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />FAIL</Badge>
              )}
              <span className="text-muted-foreground">{qaResult.account_number}</span>
            </div>

            {qaResult.assertions && (
              <div className="grid grid-cols-1 gap-1 text-xs font-mono bg-muted/50 rounded p-2">
                {Object.entries(qaResult.assertions).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2">
                    {val ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <XCircle className="h-3 w-3 text-destructive" />}
                    <span>{key}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
