import { TrendingUp, Shield, CheckCircle2, Activity, BarChart3 } from 'lucide-react';

/** Static, non-interactive dashboard mockup for the landing page hero.
 *  Uses representative mock data — no real account data. */
export function HeroDashboardPreview() {
  // Mock equity curve points (normalized 0-100 for SVG)
  const equityPoints = [
    0, 2, 5, 3, 8, 12, 10, 15, 18, 16, 22, 25, 28, 24, 30, 33, 35, 32,
    38, 42, 40, 45, 48, 50, 47, 52, 55, 58, 62, 60, 65, 68, 72, 70, 74,
  ];

  const pathD = equityPoints
    .map((y, i) => {
      const x = (i / (equityPoints.length - 1)) * 100;
      const yFlipped = 100 - y * 1.3; // scale + flip for SVG
      return `${i === 0 ? 'M' : 'L'} ${x} ${yFlipped}`;
    })
    .join(' ');

  return (
    <div className="relative mx-auto max-w-5xl mt-12 animate-in fade-in slide-in-from-bottom-6 duration-1000 [animation-delay:800ms]">
      {/* Glow effect behind the card */}
      <div className="absolute inset-0 -z-10 rounded-2xl bg-primary/10 blur-2xl scale-105" />

      {/* Main dashboard frame */}
      <div className="rounded-2xl border border-border/60 bg-card/80 backdrop-blur-sm shadow-2xl overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-muted/30">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-destructive/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-warning/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-success/60" />
          </div>
          <span className="text-[10px] text-muted-foreground font-mono ml-2">Trader Dashboard — $100K Evaluation</span>
        </div>

        {/* Dashboard content */}
        <div className="p-4 sm:p-6 space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="Current Balance"
              value="$107,450"
              icon={<TrendingUp className="h-3.5 w-3.5 text-success" />}
              accent="success"
            />
            <StatCard
              label="Total P&L"
              value="+$7,450"
              icon={<BarChart3 className="h-3.5 w-3.5 text-primary" />}
              accent="primary"
            />
            <StatCard
              label="Trading Days"
              value="On track"
              icon={<Activity className="h-3.5 w-3.5 text-info" />}
              accent="info"
            />
            <StatCard
              label="Rule Health"
              value="All Clear"
              icon={<Shield className="h-3.5 w-3.5 text-success" />}
              accent="success"
            />
          </div>

          {/* Equity curve + sidebar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Chart */}
            <div className="sm:col-span-2 rounded-lg border border-border/40 bg-background/50 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground">Equity Curve</span>
                <span className="text-[10px] text-success font-mono">+7.45%</span>
              </div>
              <svg viewBox="0 0 100 100" className="w-full h-28 sm:h-36" preserveAspectRatio="none">
                {/* Grid lines */}
                {[25, 50, 75].map((y) => (
                  <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="hsl(var(--border))" strokeWidth="0.3" strokeDasharray="2 2" />
                ))}
                {/* Gradient fill */}
                <defs>
                  <linearGradient id="heroEquityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`${pathD} L 100 100 L 0 100 Z`} fill="url(#heroEquityGrad)" />
                {/* Line */}
                <path d={pathD} fill="none" stroke="hsl(var(--success))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {/* Checklist sidebar */}
            <div className="rounded-lg border border-border/40 bg-background/50 p-3 space-y-2.5">
              <span className="text-xs font-medium text-muted-foreground">Evaluation Progress</span>
              <CheckItem label="Profit Target" status="met" />
              <CheckItem label="Min Trading Days" status="met" />
              <CheckItem label="Max Drawdown" status="clear" />
              <CheckItem label="Daily Loss Limit" status="clear" />
              <CheckItem label="Consistency Rule" status="progress" />
              <CheckItem label="Staff Review" status="pending" />
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

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: 'success' | 'primary' | 'info';
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/50 p-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] text-muted-foreground">{label}</span>
      </div>
      <span className={`text-sm font-bold ${
        accent === 'success' ? 'text-success' : accent === 'primary' ? 'text-primary' : 'text-foreground'
      }`}>
        {value}
      </span>
    </div>
  );
}

function CheckItem({ label, status }: { label: string; status: 'met' | 'clear' | 'progress' | 'pending' }) {
  return (
    <div className="flex items-center gap-2">
      {status === 'met' || status === 'clear' ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
      ) : status === 'progress' ? (
        <Activity className="h-3.5 w-3.5 text-warning shrink-0" />
      ) : (
        <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
      )}
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}
