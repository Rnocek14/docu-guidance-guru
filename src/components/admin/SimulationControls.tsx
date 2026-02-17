import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Play, RefreshCw, Server, ShieldAlert, AlertTriangle, Zap } from 'lucide-react';
import { HOSTILE_PRESETS, type HostilePreset } from '@/lib/hostile-presets';

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

const BUSINESS_PRESETS: Record<string, Partial<SimOverrides>> = {
  Bootstrap: { accountsPerMonth: 50, fixedMonthlyCosts: 5000, entryFee: 149, resetFee: 99 },
  Growth: { accountsPerMonth: 200, fixedMonthlyCosts: 12000, entryFee: 149, resetFee: 99 },
  Scale: { accountsPerMonth: 500, fixedMonthlyCosts: 18000, entryFee: 149, resetFee: 99 },
};

const SEVERITY_CONFIG = {
  warning: { icon: ShieldAlert, color: 'text-warning', borderColor: 'border-warning/40' },
  critical: { icon: AlertTriangle, color: 'text-destructive', borderColor: 'border-destructive/40' },
  existential: { icon: Zap, color: 'text-destructive', borderColor: 'border-destructive/60' },
};

interface Props {
  overrides: SimOverrides;
  onChange: (o: SimOverrides) => void;
  onRun: () => void;
  onCompare: () => void;
  isRunning: boolean;
  hasResult: boolean;
  error: string | null;
  activePreset: HostilePreset | null;
  onSelectPreset: (preset: HostilePreset | null) => void;
}

export function SimulationControls({
  overrides, onChange, onRun, onCompare, isRunning, hasResult, error,
  activePreset, onSelectPreset,
}: Props) {
  const set = (patch: Partial<SimOverrides>) => onChange({ ...overrides, ...patch });

  const handlePresetSelect = (preset: HostilePreset) => {
    if (activePreset?.presetId === preset.presetId) {
      // Deselect
      onSelectPreset(null);
    } else {
      onSelectPreset(preset);
      onChange(preset.inputs);
    }
  };

  const handleBusinessPreset = (preset: Partial<SimOverrides>) => {
    onSelectPreset(null); // Clear hostile preset
    set(preset);
  };

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
        {/* Business Presets */}
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Business Scenarios</Label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(BUSINESS_PRESETS).map(([name, preset]) => (
              <Button
                key={name}
                variant={
                  !activePreset &&
                  overrides.accountsPerMonth === preset.accountsPerMonth &&
                  overrides.fixedMonthlyCosts === preset.fixedMonthlyCosts
                    ? 'default' : 'outline'
                }
                size="sm"
                onClick={() => handleBusinessPreset(preset)}
              >
                {name}
              </Button>
            ))}
          </div>
        </div>

        {/* Hostile Presets */}
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">
            Hostile Collapse Scenarios
          </Label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {HOSTILE_PRESETS.map((preset) => {
              const isActive = activePreset?.presetId === preset.presetId;
              const cfg = SEVERITY_CONFIG[preset.severity];
              const Icon = cfg.icon;

              return (
                <button
                  key={preset.presetId}
                  onClick={() => handlePresetSelect(preset)}
                  className={`
                    text-left rounded-lg border p-3 transition-colors
                    ${isActive
                      ? `${cfg.borderColor} bg-muted/50 ring-1 ring-offset-1 ring-muted-foreground/20`
                      : 'border-muted hover:border-muted-foreground/30 hover:bg-muted/30'
                    }
                  `}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                    <span className="text-sm font-medium truncate">{preset.name.replace('Hostile: ', '')}</span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{preset.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="outline" className="text-[10px]">
                      {preset.severity}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {preset.expectedAssertions.length} assertions
                    </Badge>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active preset detail */}
        {activePreset && (
          <div className="rounded-lg border border-muted bg-muted/20 p-3 text-sm space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">{activePreset.name}</span>
              <Badge variant="secondary" className="text-[10px]">{activePreset.scenarioVersion}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{activePreset.description}</p>
            <div className="text-xs space-y-1">
              <span className="font-medium text-muted-foreground">Expected assertions:</span>
              {activePreset.expectedAssertions.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="text-muted-foreground/50">•</span>
                  {a.description}
                </div>
              ))}
            </div>
          </div>
        )}

        <Separator />

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
            min={1} max={36} step={1}
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
            ) : activePreset ? (
              <><Play className="mr-2 h-4 w-4" />Run Hostile Scenario</>
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
