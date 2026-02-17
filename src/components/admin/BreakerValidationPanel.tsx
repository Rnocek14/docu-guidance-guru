import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldCheck, ShieldX, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';
import type { BreakerValidationResult } from '@/lib/breaker-evaluator';
import type { AssertionResult } from '@/lib/hostile-presets';

interface Props {
  assertionResults: AssertionResult[] | null;
  breakerValidation: BreakerValidationResult | null;
}

export function BreakerValidationPanel({ assertionResults, breakerValidation }: Props) {
  if (!assertionResults && !breakerValidation) return null;

  const allAssertionsPassed = assertionResults?.every(r => r.passed) ?? true;
  const breakerPassed = breakerValidation?.overallPass ?? true;
  const overallPass = allAssertionsPassed && breakerPassed;

  return (
    <div className="space-y-4">
      {/* Overall Verdict */}
      <Card className={overallPass ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            {overallPass
              ? <ShieldCheck className="h-6 w-6 text-success" />
              : <ShieldX className="h-6 w-6 text-destructive" />
            }
            <div>
              <CardTitle className="text-lg">
                Breaker Validation: {overallPass ? 'PASS' : 'FAIL'}
              </CardTitle>
              <CardDescription>
                Simulation assertions + live DB config check
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Simulation Assertions */}
      {assertionResults && assertionResults.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Scenario Assertions</CardTitle>
            <CardDescription>Expected outcomes from this hostile scenario</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {assertionResults.map((r, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-b last:border-0">
                {r.passed
                  ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                }
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.assertion.description}</div>
                  <div className="text-xs text-muted-foreground">{r.detail}</div>
                </div>
                <Badge
                  variant={r.passed ? 'outline' : 'destructive'}
                  className="ml-auto shrink-0"
                >
                  {r.passed ? 'PASS' : 'FAIL'}
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
