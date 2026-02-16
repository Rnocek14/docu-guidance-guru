import { useEffect, useRef } from 'react';
import { Check, X, Minus, ShieldCheck } from 'lucide-react';
import { track } from '@/lib/track';

interface CompareRow {
  feature: string;
  others: string;
  othersOk: boolean | null;
  us: string;
  usOk: boolean;
}

const rows: CompareRow[] = [
  {
    feature: 'Rule Changes Mid-Challenge',
    others: 'Common at some firms',
    othersOk: false,
    us: 'Published at purchase, versioned',
    usOk: true,
  },
  {
    feature: 'Breach Decisions',
    others: 'Often algorithm-driven',
    othersOk: false,
    us: 'Reviewed by staff before action',
    usOk: true,
  },
  {
    feature: 'Payout Review',
    others: 'Varies widely by firm',
    othersOk: false,
    us: 'Staff-reviewed, decisions logged',
    usOk: true,
  },
  {
    feature: 'Lifetime Payout Caps',
    others: 'Not disclosed by some firms', // lint-copy: allow
    othersOk: false,
    us: 'Disclosed on pricing page',
    usOk: true,
  },
  {
    feature: 'Decision Logging',
    others: 'Varies by firm',
    othersOk: false,
    us: 'Key actions logged for review',
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
          <div className="inline-flex items-center gap-2 text-sm text-primary font-semibold uppercase tracking-wider mb-3">
            <ShieldCheck className="h-4 w-4" />
            Honest Comparison
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Us vs. The Industry</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            We chose tighter rules and lower splits so we can reliably pay approved requests.
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          {/* Header row */}
          <div className="hidden sm:grid grid-cols-[1.2fr_1fr_1fr] gap-3 mb-3 px-4">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Feature</span>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Typical Prop Firms</span>
            <span className="text-xs font-semibold text-primary uppercase tracking-wider">Meridian</span>
          </div>

          {/* Rows */}
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.feature}
                className="grid sm:grid-cols-[1.2fr_1fr_1fr] gap-3 rounded-xl border border-border bg-card/40 p-4 hover:bg-card/70 transition-colors"
              >
                {/* Feature name */}
                <div className="font-medium text-sm text-foreground">{row.feature}</div>

                {/* Others */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <StatusIcon ok={row.othersOk} />
                  <span>{row.others}</span>
                </div>

                {/* Us */}
                <div className="flex items-center gap-2 text-sm">
                  <StatusIcon ok={row.usOk} />
                  <span className="font-medium text-foreground">{row.us}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-8 max-w-2xl mx-auto">
          Comparisons reflect common industry patterns based on publicly available information.
          "Typical" is not a claim about any specific firm. Your experience may vary.
        </p>
      </div>
    </section>
  );
}
