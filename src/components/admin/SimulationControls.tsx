import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Play, RefreshCw, Server } from 'lucide-react';

export interface SimOverrides {
  accountsPerMonth: number;
  fixedMonthlyCosts: number;
  entryFee: number;
  resetFee: number;
  horizon: number;
  attackIntensity: number;
  iterations: number;
  reserveThreshold: number;
}

const PRESETS: Record<string, Partial<SimOverrides>> = {
  Bootstrap: { accountsPerMonth: 50, fixedMonthlyCosts: 5000, entryFee: 149, resetFee: 99 },
  Growth: { accountsPerMonth: 200, fixedMonthlyCosts: 12000, entryFee: 149, resetFee: 99 },
  Scale: { accountsPerMonth: 500, fixedMonthlyCosts: 18000, entryFee: 149, resetFee: 99 },
};

interface Props {
  overrides: SimOverrides;
  onChange: (o: SimOverrides) => void;
  onRun: () => void;
  onCompare: () => void;
  isRunning: boolean;
  hasResult: boolean;
  error: string | null;
}

export function SimulationControls({ overrides, onChange, onRun, onCompare, isRunning, hasResult, error }: Props) {
  const set = (patch: Partial<SimOverrides>) => onChange({ ...overrides, ...patch });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Simulation Parameters</CardTitle>
        </div>
        <CardDescription>
          Uses real cohort configs from your database. Override economic assumptions below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Presets */}
        <div className="flex flex-wrap gap-2">
          {Object.entries(PRESETS).map(([name, preset]) => (
            <Button
              key={name}
              variant={
                overrides.accountsPerMonth === preset.accountsPerMonth &&
                overrides.fixedMonthlyCosts === preset.fixedMonthlyCosts
                  ? 'default' : 'outline'
              }
              size="sm"
              onClick={() => set(preset)}
            >
              {name}
            </Button>
          ))}
        </div>

        {/* Sliders grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <SliderControl
            label="Accounts / Month"
            value={overrides.accountsPerMonth}
            onChange={(v) => set({ accountsPerMonth: v })}
            min={25} max={1000} step={25}
            format={(v) => v.toLocaleString()}
          />
          <SliderControl
            label="Fixed Monthly Costs"
            value={overrides.fixedMonthlyCosts}
            onChange={(v) => set({ fixedMonthlyCosts: v })}
            min={2000} max={30000} step={1000}
            format={(v) => `$${v.toLocaleString()}`}
          />
          <SliderControl
            label="Entry Fee"
            value={overrides.entryFee}
            onChange={(v) => set({ entryFee: v })}
            min={99} max={299} step={10}
            format={(v) => `$${v}`}
          />
          <SliderControl
            label="Reset Fee"
            value={overrides.resetFee}
            onChange={(v) => set({ resetFee: v })}
            min={49} max={149} step={10}
            format={(v) => `$${v}`}
          />
          <SliderControl
            label="Horizon (months)"
            value={overrides.horizon}
            onChange={(v) => set({ horizon: v })}
            min={6} max={36} step={1}
            format={(v) => `${v} mo`}
          />
          <SliderControl
            label="Attack Intensity"
            value={overrides.attackIntensity}
            onChange={(v) => set({ attackIntensity: v })}
            min={0} max={1} step={0.05}
            format={(v) => v.toFixed(2)}
            hint="Models coordinated fraud / exploit scenarios"
          />
          <SliderControl
            label="Iterations"
            value={overrides.iterations}
            onChange={(v) => set({ iterations: v })}
            min={500} max={5000} step={500}
            format={(v) => v.toLocaleString()}
            hint="More = more accurate tail risk"
          />
          <SliderControl
            label="Reserve Threshold"
            value={overrides.reserveThreshold}
            onChange={(v) => set({ reserveThreshold: v })}
            min={5000} max={50000} step={1000}
            format={(v) => `$${v.toLocaleString()}`}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button onClick={onRun} disabled={isRunning} size="lg">
            {isRunning ? (
              <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Running ({overrides.iterations.toLocaleString()})...</>
            ) : (
              <><Play className="mr-2 h-4 w-4" />Run Simulation</>
            )}
          </Button>
          {hasResult && (
            <Button variant="outline" size="lg" onClick={onCompare}>
              Save for Comparison
            </Button>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SliderControl({
  label, value, onChange, min, max, step, format, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; format: (v: number) => string; hint?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-sm font-medium">{format(value)}</span>
      </div>
      <Slider value={[value]} onValueChange={([v]) => onChange(v)} min={min} max={max} step={step} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
