import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldCheck, ShieldX, ShieldAlert, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';
import type { BreakerValidationResult } from '@/lib/breaker-evaluator';
import type { AssertionResult, OverallVerdict } from '@/lib/hostile-presets';
import { computeOverallVerdict } from '@/lib/hostile-presets';

interface Props {
  assertionResults: AssertionResult[] | null;
  breakerValidation: BreakerValidationResult | null;
}

export function BreakerValidationPanel({ assertionResults, breakerValidation }: Props) {
  if (!assertionResults && !breakerValidation) return null;

  const verdict: OverallVerdict = computeOverallVerdict(assertionResults, breakerValidation);

  const verdictConfig = {
    pass: { icon: ShieldCheck, label: 'PASS', color: 'border-success/50 bg-success/5', iconColor: 'text-success' },
    fail: { icon: ShieldX, label: 'FAIL', color: 'border-destructive/50 bg-destructive/5', iconColor: 'text-destructive' },
    incomplete: { icon: ShieldAlert, label: 'INCOMPLETE', color: 'border-warning/50 bg-warning/5', iconColor: 'text-warning' },
  }[verdict];

  const VerdictIcon = verdictConfig.icon;

  // Split assertions into binding vs informational
  const bindingAssertions = assertionResults?.filter(r => !r.isInformational) ?? [];
  const informationalAssertions = assertionResults?.filter(r => r.isInformational) ?? [];

  return (
    <div className="space-y-4">
      {/* Overall Verdict */}
      <Card className={verdictConfig.color}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <VerdictIcon className={`h-6 w-6 ${verdictConfig.iconColor}`} />
            <div>
              <CardTitle className="text-lg">
                Breaker Validation: {verdictConfig.label}
              </CardTitle>
              <CardDescription>
                {verdict === 'incomplete'
                  ? 'Missing assertion results or DB validation — cannot certify'
                  : 'Binding assertions + live DB config check'
                }
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Binding Assertions */}
      {bindingAssertions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Binding Assertions</CardTitle>
            <CardDescription>These determine pass/fail</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {bindingAssertions.map((r, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b last:border-0">
                {r.passed
                  ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                }
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.assertion.description}</div>
                  <div className="text-xs text-muted-foreground">{r.detail}</div>
                </div>
                {!r.passed && r.detail.startsWith('MISSING METRIC') ? (
                  <Badge variant="destructive" className="ml-auto shrink-0 opacity-90">
                    DATA GAP
                  </Badge>
                ) : (
                  <Badge
                    variant={r.passed ? 'outline' : 'destructive'}
                    className="ml-auto shrink-0"
                >
                    {r.passed ? 'PASS' : 'FAIL'}
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Informational Assertions */}
      {informationalAssertions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Advisory (Informational)</CardTitle>
            <CardDescription>These do not affect overall pass/fail</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {informationalAssertions.map((r, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b last:border-0">
                <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.assertion.description}</div>
                  <div className="text-xs text-muted-foreground">{r.detail}</div>
                </div>
                <Badge variant="secondary" className="ml-auto shrink-0">
                  INFO
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* DB Config Validation */}
      {breakerValidation && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Live DB Config Validation</CardTitle>
            <CardDescription>
              Snapshot taken at {new Date(breakerValidation.dbSnapshot.capturedAt).toLocaleTimeString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {breakerValidation.validations.map((v, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b last:border-0">
                {v.severity === 'error' && !v.passed
                  ? <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  : v.severity === 'warning' && !v.passed
                    ? <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                    : <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                }
                <div className="min-w-0">
                  <div className="text-sm font-medium">{v.check}</div>
                  <div className="text-xs text-muted-foreground">{v.detail}</div>
                </div>
              </div>
            ))}

            {/* Config drift warnings */}
            {breakerValidation.configDriftWarnings.length > 0 && (
              <Alert variant="default" className="mt-3">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Config Drift</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside text-xs space-y-1 mt-1">
                    {breakerValidation.configDriftWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* DB snapshot warnings */}
            {breakerValidation.dbSnapshot.warnings.length > 0 && (
              <Alert variant="destructive" className="mt-3">
                <Info className="h-4 w-4" />
                <AlertTitle>DB Config Incomplete</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside text-xs space-y-1 mt-1">
                    {breakerValidation.dbSnapshot.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                  <p className="text-xs font-medium mt-2">
                    Cannot certify breaker behavior with incomplete config.
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
