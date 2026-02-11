import { useState } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import {
  FlaskConical, CheckCircle2, XCircle, Loader2, AlertTriangle,
  SkipForward, Zap, Shield, Database, CreditCard, Activity,
} from 'lucide-react';
import { toast } from 'sonner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface ScanResult {
  id: string;
  section: string;
  name: string;
  result: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
  detail: string;
  data?: unknown;
}

interface ScanResponse {
  scannedAt: string;
  summary: { total: number; pass: number; fail: number; skip: number; error: number };
  allPass: boolean;
  results: ScanResult[];
}

const sectionIcons: Record<string, React.ReactNode> = {
  'Connectivity': <Zap className="h-4 w-4" />,
  'Payout Pipeline': <CreditCard className="h-4 w-4" />,
  'Risk Actions': <Shield className="h-4 w-4" />,
  'DB Invariants': <Database className="h-4 w-4" />,
};

const resultIcon = (r: string) => {
  switch (r) {
    case 'PASS': return <CheckCircle2 className="h-4 w-4 text-primary" />;
    case 'FAIL': return <XCircle className="h-4 w-4 text-destructive" />;
    case 'SKIP': return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    case 'ERROR': return <AlertTriangle className="h-4 w-4 text-destructive" />;
    default: return null;
  }
};

const resultBadgeVariant = (r: string) => {
  switch (r) {
    case 'PASS': return 'default' as const;
    case 'FAIL': return 'destructive' as const;
    case 'SKIP': return 'secondary' as const;
    case 'ERROR': return 'destructive' as const;
    default: return 'secondary' as const;
  }
};

export default function QaScanRunner() {
  const [running, setRunning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [selectedPayout, setSelectedPayout] = useState('');
  const [selectedBreach, setSelectedBreach] = useState('');

  // Fetch eligible SEEDV2/DEMO payouts
  const { data: eligiblePayouts } = useQuery({
    queryKey: ['qa-eligible-payouts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payouts')
        .select('id, status, amount, accounts!inner(account_number)')
        .in('status', ['pending', 'under_review']);
      if (error) throw error;
      return (data ?? [])
        .map((p) => {
          const acct = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
          return {
            id: p.id, status: p.status, amount: Number(p.amount),
            account_number: (acct as { account_number: string })?.account_number ?? 'unknown',
          };
        })
        .filter((p) => p.account_number.startsWith('SEEDV2-') || p.account_number.startsWith('DEMO-'));
    },
  });

  // Fetch eligible SEEDV2/DEMO breached accounts
  const { data: breachedAccounts } = useQuery({
    queryKey: ['qa-breached-accounts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('id, account_number, status')
        .in('status', ['breached_detected', 'under_review'])
        .or('account_number.like.SEEDV2-%,account_number.like.DEMO-%');
      if (error) throw error;
      return data ?? [];
    },
  });

  const runScan = async () => {
    setRunning(true);
    setScanResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('Not authenticated'); return; }

      const body: Record<string, string> = {};
      if (selectedPayout) body.payout_id = selectedPayout;
      if (selectedBreach) body.breach_account_id = selectedBreach;

      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/qa-full-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      const raw = await res.text();
      let parsed: ScanResponse;
      try { parsed = JSON.parse(raw); } catch { toast.error('Non-JSON response'); return; }

      setScanResult(parsed);
      if (parsed.allPass) {
        toast.success(`Full QA Scan: ALL PASS (${parsed.summary.pass}/${parsed.summary.total})`);
      } else {
        toast.warning(`QA Scan: ${parsed.summary.fail} FAIL, ${parsed.summary.error} ERROR`);
      }
    } catch (err) {
      toast.error('Network error: ' + String(err));
    } finally {
      setRunning(false);
    }
  };

  // Group results by section
  const grouped = scanResult?.results.reduce<Record<string, ScanResult[]>>((acc, r) => {
    if (!acc[r.section]) acc[r.section] = [];
    acc[r.section].push(r);
    return acc;
  }, {}) ?? {};

  return (
    <DashboardLayout title="QA Scan Runner" navItems={adminNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Full QA Scan</h2>
          <p className="text-muted-foreground">
            One-click end-to-end verification: connectivity, payout pipeline, risk actions, and DB invariants.
          </p>
        </div>

        {/* Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="h-5 w-5" />
              Scan Configuration
            </CardTitle>
            <CardDescription>
              Optionally select a SEEDV2/DEMO payout and/or breached account to include live pipeline tests.
              DB invariant checks always run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Payout to approve (Section B)</label>
                <Select value={selectedPayout} onValueChange={setSelectedPayout}>
                  <SelectTrigger>
                    <SelectValue placeholder="(optional) Select payout..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— None —</SelectItem>
                    {(eligiblePayouts ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.account_number} — ${p.amount} ({p.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Breached account (Section C)</label>
                <Select value={selectedBreach} onValueChange={setSelectedBreach}>
                  <SelectTrigger>
                    <SelectValue placeholder="(optional) Select account..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— None —</SelectItem>
                    {(breachedAccounts ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.account_number} ({a.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Sections B & C execute real state transitions on SEEDV2/DEMO data. DB invariant checks (D) are read-only.</span>
            </div>

            <Button onClick={runScan} disabled={running} size="lg" className="w-full sm:w-auto">
              {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Activity className="h-4 w-4 mr-2" />}
              {running ? 'Running Full Scan...' : 'Run Full QA Scan'}
            </Button>
          </CardContent>
        </Card>

        {/* Summary */}
        {scanResult && (
          <Card className={scanResult.allPass ? 'border-primary' : 'border-destructive'}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {scanResult.allPass
                  ? <CheckCircle2 className="h-5 w-5 text-primary" />
                  : <XCircle className="h-5 w-5 text-destructive" />}
                {scanResult.allPass ? 'ALL CHECKS PASSED' : 'ISSUES DETECTED'}
              </CardTitle>
              <CardDescription>
                Scanned at {new Date(scanResult.scannedAt).toLocaleString()} —{' '}
                {scanResult.summary.pass} pass, {scanResult.summary.fail} fail,{' '}
                {scanResult.summary.skip} skip, {scanResult.summary.error} error
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {/* Results by section */}
        {Object.entries(grouped).map(([section, checks]) => {
          const sectionPass = checks.every(c => c.result === 'PASS' || c.result === 'SKIP');
          return (
            <Card key={section}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {sectionIcons[section] ?? <Database className="h-4 w-4" />}
                  {section}
                  <Badge variant={sectionPass ? 'default' : 'destructive'} className="ml-auto">
                    {sectionPass ? 'OK' : 'ISSUES'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {checks.map((check) => (
                  <Collapsible key={check.id}>
                    <CollapsibleTrigger className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-muted/50 transition-colors">
                      {resultIcon(check.result)}
                      <span className="text-sm flex-1 font-mono">
                        [{check.id}] {check.name}
                      </span>
                      <Badge variant={resultBadgeVariant(check.result)} className="text-xs">
                        {check.result}
                      </Badge>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="ml-6 mt-1 mb-2">
                      <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2 font-mono whitespace-pre-wrap">
                        <div>{check.detail}</div>
                        {check.data && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                              Raw data
                            </summary>
                            <pre className="mt-1 text-[10px] overflow-x-auto">
                              {JSON.stringify(check.data, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </DashboardLayout>
  );
}
