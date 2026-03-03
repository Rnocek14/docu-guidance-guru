import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { Play, RefreshCw, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';

interface SweepSummary {
  n: number;
  run_id: string | null;
  profit_mean: number;
  profit_p5: number;
  p_loss: number;
  max_dd: number;
  reserve_breach: number;
  worst_month: number;
  duration_ms: number;
}

interface SweepResult {
  sweep_id: string;
  sweep_type: string;
  preset: string;
  run_ids: string[];
  summaries: SweepSummary[];
  errors?: { n: number; error: string }[];
  config: {
    seed: number;
    months: number;
    iterations: number;
    reserve_threshold: number;
    accountsPerMonthList: number[];
  };
}

const DEFAULT_N_LIST = [100, 150, 200, 300, 500];

export function SweepPanel() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const runSweep = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);
    setProgress('Authenticating...');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      setProgress(`Running N-sweep: ${DEFAULT_N_LIST.join(', ')} accounts/mo...`);

      const response = await fetch(
        `https://${import.meta.env.VITE_SUPABASE_PROJECT_ID}.supabase.co/functions/v1/run-sweep`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            preset: 'baseline',
            seed: 42,
            months: 12,
            iterations: 2000,
            reserve_threshold: 16000,
            accountsPerMonthList: DEFAULT_N_LIST,
            sweep_type: 'N_SWEEP',
            knobs: {
              targetPayRevSoft: 0.45,
              payRevEngageThreshold: 0.38,
            },
          }),
        },
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Sweep failed');

      setResult(data as SweepResult);
      setProgress(null);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    } finally {
      setIsRunning(false);
    }
  }, []);

  const fmt = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  // Find breakeven N
  const breakEvenN = result?.summaries.find(s => s.profit_mean > 0)?.n ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">MES Breakeven Sweep</CardTitle>
        </div>
        <CardDescription>
          Run controlled N-sweep ({DEFAULT_N_LIST.join(', ')} accounts/mo) to find Minimum Efficient Scale.
          Same seed, same knobs — only accountsPerMonth changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button onClick={runSweep} disabled={isRunning} size="lg">
            {isRunning ? (
              <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />{progress || 'Running...'}</>
            ) : (
              <><Play className="mr-2 h-4 w-4" />Run N-Sweep (5 points)</>
            )}
          </Button>
          {result && (
            <Badge variant="outline" className="text-xs">
              Sweep: {result.sweep_id.slice(0, 8)}
            </Badge>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <>
            {/* Breakeven indicator */}
            {breakEvenN && (
              <div className="rounded-lg border border-success/50 bg-success/10 p-3 text-sm">
                <strong>MES Estimate:</strong> Breakeven at <strong>N ≈ {breakEvenN}</strong> accounts/month
                (first N where mean monthly profit turns positive).
              </div>
            )}
            {!breakEvenN && result.summaries.length > 0 && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
                <strong>Warning:</strong> No sweep point reached positive mean profit.
                MES may be above {DEFAULT_N_LIST[DEFAULT_N_LIST.length - 1]} accounts/month.
              </div>
            )}

            {/* MES Curve Table */}
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">N</TableHead>
                    <TableHead>Mean Profit</TableHead>
                    <TableHead>Worst Month</TableHead>
                    <TableHead>P5 (Worst)</TableHead>
                    <TableHead>P(Loss)</TableHead>
                    <TableHead>Max DD</TableHead>
                    <TableHead>Reserve Breach</TableHead>
                    <TableHead className="w-[80px]">Run ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.summaries.map((s) => (
                    <TableRow key={s.n} className={s.profit_mean > 0 ? '' : 'bg-destructive/5'}>
                      <TableCell className="font-medium">{s.n}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {s.profit_mean >= 0 ? (
                            <TrendingUp className="h-3 w-3 text-success" />
                          ) : (
                            <TrendingDown className="h-3 w-3 text-destructive" />
                          )}
                          <span className={s.profit_mean >= 0 ? 'text-success font-medium' : 'text-destructive font-medium'}>
                            {fmt(s.profit_mean)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={s.worst_month < 0 ? 'text-destructive font-medium' : ''}>
                        {fmt(s.worst_month)}
                      </TableCell>
                      <TableCell className={s.profit_p5 < 0 ? 'text-destructive' : ''}>
                        {fmt(s.profit_p5)}
                      </TableCell>
                      <TableCell className={s.p_loss > 0.1 ? 'text-destructive font-medium' : ''}>
                        {pct(s.p_loss)}
                      </TableCell>
                      <TableCell>{fmt(s.max_dd)}</TableCell>
                      <TableCell className={s.reserve_breach > 0.1 ? 'text-destructive font-medium' : ''}>
                        {pct(s.reserve_breach)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {s.run_id?.slice(0, 8) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Errors */}
            {result.errors && result.errors.length > 0 && (
              <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm space-y-1">
                <strong>Partial failures:</strong>
                {result.errors.map((e, i) => (
                  <div key={i}>N={e.n}: {e.error}</div>
                ))}
              </div>
            )}

            {/* Config summary */}
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Seed: {result.config.seed}</Badge>
              <Badge variant="outline">Months: {result.config.months}</Badge>
              <Badge variant="outline">Iterations: {result.config.iterations}</Badge>
              <Badge variant="outline">Reserve: ${result.config.reserve_threshold.toLocaleString()}</Badge>
              <Badge variant="outline">Pacing: 0.45 / 0.38</Badge>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
