import { useEffect, useRef, useState } from 'react';
import { Activity, TrendingUp, CheckCircle2, Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { track } from '@/lib/track';

/* ─── Mock payout activity ────────────────────────────────────── */

type PayoutEvent = {
  initials: string;
  tier: string;
  amount: number;
  ago: string;
  status: 'paid' | 'review';
};

const seedFeed: PayoutEvent[] = [
  { initials: 'M.K.', tier: 'Pro · 50K',    amount: 1240, ago: '2m ago',  status: 'paid' },
  { initials: 'J.R.', tier: 'Starter · 25K', amount: 615,  ago: '11m ago', status: 'paid' },
  { initials: 'D.S.', tier: 'Elite · 100K',  amount: 3180, ago: '24m ago', status: 'paid' },
  { initials: 'A.P.', tier: 'Pro · 50K',     amount: 890,  ago: '38m ago', status: 'review' },
  { initials: 'C.L.', tier: 'Starter · 25K', amount: 410,  ago: '52m ago', status: 'paid' },
  { initials: 'R.T.', tier: 'Elite · 100K',  amount: 2450, ago: '1h ago',  status: 'paid' },
  { initials: 'N.V.', tier: 'Pro · 50K',     amount: 1075, ago: '1h ago',  status: 'paid' },
  { initials: 'K.B.', tier: 'Starter · 25K', amount: 290,  ago: '2h ago',  status: 'paid' },
];

/** Animated counter that ticks up to `target` over `durationMs`. */
function useCountUp(target: number, durationMs = 1400, start = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, start]);
  return value;
}

export function Testimonials() {
  const sectionRef = useRef<HTMLElement>(null);
  const tracked = useRef(false);
  const [inView, setInView] = useState(false);
  const [feed, setFeed] = useState(seedFeed);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('testimonial_view');
    }
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setInView(true),
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Subtle feed rotation — feels alive without being noisy
  useEffect(() => {
    if (!inView) return;
    const id = setInterval(() => {
      setFeed((prev) => {
        const [first, ...rest] = prev;
        return [...rest, first];
      });
    }, 3200);
    return () => clearInterval(id);
  }, [inView]);

  const totalPaid = useCountUp(284_750, 1600, inView);
  const payouts = useCountUp(412, 1400, inView);
  const avgDays = useCountUp(2, 1000, inView);

  return (
    <section
      ref={sectionRef}
      className="py-20 lg:py-28 border-t border-border bg-card/30 overflow-hidden"
    >
      <div className="container mx-auto px-4">
        {/* Heading */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 text-sm text-primary font-semibold uppercase tracking-wider mb-4">
            <Activity className="h-4 w-4" />
            Inside Meridian
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            A Live Trading Environment
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Funded accounts. Reviewed payouts. Real cash sent on schedule.
          </p>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-3 gap-4 max-w-3xl mx-auto mb-10">
          <StatPill
            label="Paid to Traders"
            value={`$${totalPaid.toLocaleString()}`}
            sub="Lifetime, simulated-funded"
          />
          <StatPill
            label="Payouts Processed"
            value={payouts.toLocaleString()}
            sub="Across all tiers"
          />
          <StatPill
            label="Avg. Time to Pay"
            value={`${avgDays} days`}
            sub="After staff review"
          />
        </div>

        {/* Feed + payout receipt */}
        <div className="grid lg:grid-cols-5 gap-6 max-w-5xl mx-auto">
          {/* Live feed */}
          <Card className="lg:col-span-3 border-border bg-card/60 overflow-hidden">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    Recent Payout Activity
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Last 24h
                </span>
              </div>

              <div className="space-y-1.5">
                {feed.slice(0, 5).map((p, i) => (
                  <div
                    key={`${p.initials}-${p.ago}-${i}`}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/40 bg-background/40 animate-in fade-in slide-in-from-top-1 duration-500"
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary shrink-0">
                      {p.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        Payout {p.status === 'paid' ? 'sent' : 'in review'}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.tier} · {p.ago}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono text-foreground">
                        ${p.amount.toLocaleString()}
                      </div>
                      <div
                        className={`text-[10px] inline-flex items-center gap-0.5 ${
                          p.status === 'paid' ? 'text-success' : 'text-warning'
                        }`}
                      >
                        {p.status === 'paid' ? (
                          <>
                            <CheckCircle2 className="h-2.5 w-2.5" /> Paid
                          </>
                        ) : (
                          <>
                            <Clock className="h-2.5 w-2.5" /> Review
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-[10px] text-muted-foreground/70 mt-3 italic">
                Illustrative activity. Trader initials anonymized; payouts reflect typical Meridian volume.
              </p>
            </CardContent>
          </Card>

          {/* Payout receipt card */}
          <Card className="lg:col-span-2 border-border bg-gradient-to-br from-card/80 to-card/40 overflow-hidden">
            <CardContent className="p-5 flex flex-col h-full">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Payout Receipt
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success font-semibold border border-success/20">
                  <CheckCircle2 className="h-2.5 w-2.5" /> Confirmed
                </span>
              </div>

              <div className="flex-1">
                <div className="text-[11px] text-muted-foreground mb-1">Amount</div>
                <div className="text-3xl font-extrabold font-mono text-foreground mb-1">
                  $3,180.<span className="text-muted-foreground">00</span>
                </div>
                <div className="text-[11px] text-muted-foreground mb-5">
                  Elite · 100K simulated account
                </div>

                <div className="space-y-1.5 text-[11px] border-t border-border/40 pt-3">
                  <Row k="Method" v="ACH · ending 4421" />
                  <Row k="Submitted" v="May 17, 2026" />
                  <Row k="Reviewed" v="May 18, 2026" />
                  <Row k="Settled" v="May 19, 2026" />
                  <Row k="Reference" v="MRD-PO-08412" mono />
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-border/40 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <TrendingUp className="h-3 w-3 text-primary" />
                Reviewed by staff. Logged with timestamp.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function StatPill({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-3.5 text-center">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-extrabold font-mono text-foreground tabular-nums">
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-foreground font-medium ${mono ? 'font-mono text-[10px]' : ''}`}>
        {v}
      </span>
    </div>
  );
}
