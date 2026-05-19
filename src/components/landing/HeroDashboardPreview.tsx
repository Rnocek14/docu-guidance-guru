import { 
  TrendingUp, Shield, CheckCircle2, AlertTriangle, Calendar, 
  DollarSign, Target, Compass, ShieldCheck, ChevronRight,
  XCircle, CircleDollarSign
} from 'lucide-react';

/** Static dashboard mockup that mirrors the actual TraderDashboard layout.
 *  Uses representative mock data — no real account data. */
export function HeroDashboardPreview() {
  // Mock equity curve (realistic shape: steady climb with pullbacks)
  const equityPoints = [
    100000, 100250, 100800, 100400, 101200, 101900, 101500, 102400, 103100,
    102600, 103500, 104200, 104800, 104100, 105000, 105600, 106200, 105700,
    106500, 107100, 106700, 107450,
  ];
  const minY = 99000;
  const maxY = 108500;

  // ViewBox matches the real EquityCurveChart aspect-[16/6] so circles stay
  // circular and the line slope reads the same on the landing preview.
  const VB_W = 160;
  const VB_H = 60;
  const PAD_L = 4;
  const PAD_R = 4;
  const PAD_T = 3;
  const PAD_B = 3;
  const innerW = VB_W - PAD_L - PAD_R;
  const innerH = VB_H - PAD_T - PAD_B;

  const xAt = (i: number) => PAD_L + (i / (equityPoints.length - 1)) * innerW;
  const yAt = (v: number) => PAD_T + (1 - (v - minY) / (maxY - minY)) * innerH;

  const pathD = equityPoints
    .map((y, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(y).toFixed(2)}`)
    .join(' ');

  const drawdownY = yAt(90000);
  const targetY = yAt(110000);
  const lastX = xAt(equityPoints.length - 1);
  const lastY = yAt(equityPoints[equityPoints.length - 1]);

  return (
    <div className="relative mx-auto max-w-5xl mt-4 sm:mt-6 animate-in fade-in slide-in-from-bottom-6 duration-1000 [animation-delay:800ms]">
      {/* Glow */}
      <div className="absolute inset-0 -z-10 rounded-2xl bg-primary/8 blur-2xl scale-105" />

      {/* Floating "Payout Paid" notification — single live trading artifact */}
      <div className="hidden sm:flex absolute -top-4 right-4 sm:right-8 z-10 items-center gap-2 rounded-lg border border-success/30 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg animate-in fade-in slide-in-from-top-2 duration-700 [animation-delay:1400ms]">
        <div className="rounded-full bg-success/15 p-1.5">
          <CircleDollarSign className="h-3.5 w-3.5 text-success" />
        </div>
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-foreground">Payout Paid</span>
            <span className="text-[9px] px-1 py-0.5 rounded bg-success/15 text-success font-medium">ACH</span>
          </div>
          <span className="text-[9px] text-muted-foreground font-mono">$3,180.00 · just now</span>
        </div>
        <span className="relative flex h-1.5 w-1.5 ml-1">
          <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
        </span>
      </div>

      <div className="rounded-2xl border border-border/60 bg-card/90 backdrop-blur-sm shadow-2xl overflow-hidden">
        {/* Window chrome */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-muted/20">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-destructive/50" />
            <div className="w-2.5 h-2.5 rounded-full bg-warning/50" />
            <div className="w-2.5 h-2.5 rounded-full bg-success/50" />
          </div>
          <span className="text-[10px] text-muted-foreground/70 font-mono ml-2">
            Trader Dashboard
          </span>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {/* Header — matches real dashboard */}
          <div>
            <div className="text-sm font-bold text-foreground">Welcome back</div>
            <div className="text-[10px] text-muted-foreground">Here's an overview of your trading challenge progress.</div>
          </div>

          {/* Phase indicator — matches real AccountPhaseIndicator */}
          <div className="rounded-lg border border-primary/30 bg-primary/10 p-2.5">
            <div className="flex items-start gap-2">
              <div className="rounded-full bg-primary/20 p-1.5">
                <Target className="h-3.5 w-3.5 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-primary">Challenge Phase</span>
                  <span className="text-[8px] px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/30 font-medium">Evaluation</span>
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">
                  Hit your 10% performance target to advance.
                </div>
              </div>
            </div>
          </div>

          {/* 4 stat cards — matches real layout */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <MiniStatCard
              title="Current Balance"
              value="$107,450"
              subtitle="Started at $100,000"
              icon={<DollarSign className="h-3 w-3 text-muted-foreground" />}
            />
            <MiniStatCard
              title="Total P&L"
              value="+$7,450"
              subtitle="7.45% simulated return"
              icon={<TrendingUp className="h-3 w-3 text-success" />}
              valueClass="text-success"
            />
            <MiniStatCard
              title="Current Drawdown"
              value="1.02%"
              subtitle="Max allowed: 10%"
              icon={<AlertTriangle className="h-3 w-3 text-muted-foreground" />}
            />
            <MiniStatCard
              title="Trading Days"
              value="18"
              subtitle="Minimum: 5 days"
              icon={<Calendar className="h-3 w-3 text-muted-foreground" />}
            />
          </div>

          {/* Equity Curve — matches real chart area */}
          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-medium text-foreground">Equity Curve</span>
              <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5 bg-primary inline-block rounded" /> Balance
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5 bg-primary inline-block rounded opacity-50" /> Target
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-0.5 bg-destructive inline-block rounded opacity-50" /> Max Drawdown
                </span>
              </div>
            </div>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="w-full aspect-[16/6]" preserveAspectRatio="xMidYMid meet">
              {/* Grid */}
              {[0.2, 0.4, 0.6, 0.8].map((f) => (
                <line key={f} x1={PAD_L} y1={PAD_T + f * innerH} x2={VB_W - PAD_R} y2={PAD_T + f * innerH} stroke="hsl(var(--border))" strokeWidth="0.15" strokeDasharray="0.6 1.2" />
              ))}
              {/* Drawdown limit */}
              <line x1={PAD_L} y1={drawdownY} x2={VB_W - PAD_R} y2={drawdownY} stroke="hsl(var(--destructive))" strokeWidth="0.25" strokeDasharray="1.2 1.2" opacity="0.5" />
              {/* Profit target */}
              <line x1={PAD_L} y1={targetY} x2={VB_W - PAD_R} y2={targetY} stroke="hsl(var(--primary))" strokeWidth="0.25" strokeDasharray="1.2 1.2" opacity="0.5" />
              {/* Fill */}
              <defs>
                <linearGradient id="heroEqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${pathD} L ${VB_W - PAD_R} ${VB_H - PAD_B} L ${PAD_L} ${VB_H - PAD_B} Z`} fill="url(#heroEqGrad)" />
              {/* Line */}
              <path d={pathD} fill="none" stroke="hsl(var(--primary))" strokeWidth="0.55" strokeLinecap="round" strokeLinejoin="round" />
              {/* Current price dot — pulsing halo conveys "live" */}
              <g>
                <circle cx={lastX} cy={lastY} r="0.9" fill="hsl(var(--primary))" opacity="0.35">
                  <animate attributeName="r" values="0.9;2.4;0.9" dur="2.4s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite" />
                </circle>
                <circle cx={lastX} cy={lastY} r="0.8" fill="hsl(var(--background))" stroke="hsl(var(--primary))" strokeWidth="0.4" />
              </g>
            </svg>
          </div>

          {/* 3-column grid: Rule Health / What's Next / Review Readiness — matches real layout */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {/* Rule Health */}
            <MiniCard title="Rule Health" icon={<Shield className="h-3.5 w-3.5 text-primary" />} badge={{ label: 'Stable', color: 'success' }}>
              <div className="space-y-2">
                <MiniBar label="Drawdown Usage" level="Low" pct={17} />
                <MiniBar label="Worst Single Day" level="Low" pct={12} />
                <div className="border-t border-border/30 pt-1.5 mt-1.5">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Discipline</div>
                  <div className="grid grid-cols-3 gap-1 text-center">
                    <div>
                      <div className="text-xs font-bold font-mono">2.41</div>
                      <div className="text-[8px] text-muted-foreground">Daily Profit Factor</div>
                    </div>
                    <div>
                      <div className="text-xs font-bold font-mono text-success">+$625</div>
                      <div className="text-[8px] text-muted-foreground">Avg Win Day</div>
                    </div>
                    <div>
                      <div className="text-xs font-bold font-mono text-destructive">-$340</div>
                      <div className="text-[8px] text-muted-foreground">Avg Loss Day</div>
                    </div>
                  </div>
                </div>
                {/* Volatility + Profit Distribution */}
                <div className="border-t border-border/30 pt-1.5 mt-1.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">Volatility Score</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success font-medium">Low</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">Profit Distribution</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success font-medium">Good</span>
                  </div>
                </div>
              </div>
            </MiniCard>

            {/* What's Next */}
            <MiniCard title="What Happens Next" icon={<Compass className="h-3.5 w-3.5 text-primary" />}>
              <div className="space-y-1.5">
                <MiniCheckItem label="Minimum trading days" done={true} />
                <MiniCheckItem label="Profit target" done={true} />
                <MiniCheckItem label="Staff review of results" done={false} />
              </div>
              <div className="mt-2 rounded border border-success/20 bg-success/5 p-1.5">
                <div className="flex items-center gap-1 text-[10px] text-success font-medium">
                  <CheckCircle2 className="h-3 w-3" />
                  All milestones met — awaiting review
                </div>
              </div>
            </MiniCard>

            {/* Review Readiness Snapshot */}
            <MiniCard title="Review Readiness Snapshot" icon={<ShieldCheck className="h-3.5 w-3.5 text-primary" />} badge={{ label: 'Low Risk', color: 'success' }}>
              <div className="space-y-1.5">
                {/* Checklist items */}
                <div className="space-y-1">
                  <MiniCheckItem label="Min trading days" done={true} />
                  <MiniCheckItem label="Profit target" done={true} />
                </div>
                {/* Session risk level */}
                <div className="rounded border border-border/30 bg-muted/20 p-1.5 space-y-1 mt-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Session risk level</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success font-medium">Low Risk</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground">
                    Comfortable headroom. Normal trading is unlikely to trigger a breach.
                  </div>
                  <div className="text-[8px] text-muted-foreground/60 italic">
                    Drawdown headroom is your tightest rail today.
                  </div>
                </div>
              </div>
            </MiniCard>
          </div>

          {/* Bottom row: Performance Target + Drawdown Monitor */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <Target className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] font-medium">Performance Target</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-success/10 text-success font-medium">Target Met</span>
                <span className="text-[9px] text-muted-foreground">You've reached the profit target.</span>
              </div>
            </div>
            <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <AlertTriangle className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] font-medium">Drawdown Monitor</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-success/10 text-success font-medium">Comfortable</span>
                <span className="text-[9px] text-muted-foreground">Drawdown within acceptable range.</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating badge */}
      <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[10px] font-medium text-muted-foreground shadow-lg">
        <Shield className="h-3 w-3 text-primary" />
        Rules frozen at purchase · All decisions human-reviewed
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────── */

function MiniStatCard({
  title, value, subtitle, icon, valueClass,
}: {
  title: string; value: string; subtitle: string; icon: React.ReactNode; valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted-foreground">{title}</span>
        {icon}
      </div>
      <div className={`text-sm font-bold ${valueClass ?? 'text-foreground'}`}>{value}</div>
      <div className="text-[9px] text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function MiniCard({
  title, icon, badge, children,
}: {
  title: string; icon: React.ReactNode; badge?: { label: string; color: 'success' | 'warning' | 'destructive' }; children: React.ReactNode;
}) {
  const badgeColors = {
    success: 'text-success bg-success/10 border-success/30',
    warning: 'text-warning bg-warning/10 border-warning/30',
    destructive: 'text-destructive bg-destructive/10 border-destructive/30',
  };
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[10px] font-medium">{title}</span>
        </div>
        {badge && (
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${badgeColors[badge.color]}`}>
            {badge.label}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function MiniBar({ label, level, pct }: { label: string; level: string; pct: number }) {
  const color = pct > 70 ? 'bg-destructive' : pct > 50 ? 'bg-warning' : 'bg-success';
  const bandedWidth = pct <= 5 ? 5 : pct <= 33 ? 33 : pct <= 66 ? 66 : 100;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-muted-foreground">{label}</span>
        <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success font-medium">{level}</span>
      </div>
      <div className="h-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${bandedWidth}%` }} />
      </div>
    </div>
  );
}

function MiniCheckItem({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {done ? (
        <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
      ) : (
        <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />
      )}
      <span className={`text-[10px] ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
    </div>
  );
}
