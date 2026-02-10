import { useEffect, useRef } from 'react';
import { Check, X, Minus } from 'lucide-react';
import { track } from '@/lib/track';

interface CompareRow {
  feature: string;
  others: string;
  othersOk: boolean | null; // null = neutral
  us: string;
  usOk: boolean;
}

const rows: CompareRow[] = [
  {
    feature: 'Rule Changes Mid-Challenge',
    others: 'Common at many firms',
    othersOk: false,
    us: 'Frozen at purchase — locked contract',
    usOk: true,
  },
  {
    feature: 'Breach Decisions',
    others: 'Often auto-denied by algorithm',
    othersOk: false,
    us: 'Human-reviewed by risk staff',
    usOk: true,
  },
  {
    feature: 'Payout Denials',
    others: 'Typically automated, opaque process',
    othersOk: false,
    us: 'Human-reviewed, audit-logged',
    usOk: true,
  },
  {
    feature: 'Lifetime Payout Caps',
    others: 'Often hidden or undisclosed',
    othersOk: false,
    us: 'Disclosed upfront before purchase',
    usOk: true,
  },
  {
    feature: 'Decision Audit Trail',
    others: 'Rarely available to traders',
    othersOk: false,
    us: 'Full trail for key decisions',
    usOk: true,
  },
  {
    feature: 'Payout Split',
    others: 'Typically 80–90%',
    othersOk: null,
    us: '80–85% (sustainable model)',
    usOk: true,
  },
  {
    feature: 'Profit Target',
    others: 'Typically 6–8%',
    othersOk: null,
    us: '10% (rigorous evaluation)',
    usOk: true,
  },
];

function StatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === true) return <Check className="h-4 w-4 text-success shrink-0" />;
  if (ok === false) return <X className="h-4 w-4 text-destructive shrink-0" />;
  return <Minus className="h-4 w-4 text-muted-foreground shrink-0" />;
}

export function ComparisonTable() {
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('compare_view');
    }
  }, []);

  return (
    <section className="py-20 lg:py-28 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Us vs. The Industry</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            We chose tighter rules and lower splits so we can reliably pay approved requests.
          </p>
        </div>

        <div className="max-w-4xl mx-auto overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 font-semibold text-foreground">Feature</th>
                <th className="text-left py-3 px-4 font-semibold text-muted-foreground">Typical Prop Firms</th>
                <th className="text-left py-3 px-4 font-semibold text-primary">RiskAnalytics</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.feature} className="border-b border-border/50 hover:bg-card/50 transition-colors">
                  <td className="py-3.5 px-4 font-medium text-foreground">{row.feature}</td>
                  <td className="py-3.5 px-4 text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <StatusIcon ok={row.othersOk} />
                      {row.others}
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex items-center gap-2">
                      <StatusIcon ok={row.usOk} />
                      <span className="font-medium">{row.us}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-6 max-w-2xl mx-auto">
          Comparisons based on publicly available information from major prop trading evaluation firms.
          "Typical" reflects common industry practices, not universal claims about any specific firm.
        </p>
      </div>
    </section>
  );
}
