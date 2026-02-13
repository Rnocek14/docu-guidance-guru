import { Shield, Lock, Eye, RefreshCw, Scale, Server } from 'lucide-react';

const trustPoints = [
  {
    icon: Lock,
    title: 'Rules Frozen at Purchase',
    detail: 'Your evaluation terms are contractually locked — no mid-challenge changes.',
  },
  {
    icon: Eye,
    title: 'Human-Reviewed Decisions',
    detail: 'Breach flags and payout requests are reviewed by staff, not auto-denied.',
  },
  {
    icon: Scale,
    title: 'Caps Disclosed Upfront',
    detail: 'Lifetime earnings caps and payout limits are shown before you pay.',
  },
  {
    icon: RefreshCw,
    title: '$99 Reset, Same Rules',
    detail: 'If you breach, reset for a flat fee. No upsells, same tier and terms.',
  },
  {
    icon: Server,
    title: 'Simulated Environment',
    detail: 'All trading is simulated. Payouts are performance-based rewards.',
  },
  {
    icon: Shield,
    title: 'Full Audit Trail',
    detail: 'Every key decision is logged with timestamps and reasoning.',
  },
];

export function TrustStrip() {
  return (
    <section className="py-16 lg:py-20 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <p className="text-sm font-semibold text-primary uppercase tracking-wider mb-2">
            Why Traders Trust Meridian
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">
            Built for Transparency, Not Hype
          </h2>
          <p className="text-muted-foreground max-w-lg mx-auto text-sm">
            No surprise rule changes. No automated denials. No hidden caps.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl mx-auto">
          {trustPoints.map(({ icon: Icon, title, detail }) => (
            <div
              key={title}
              className="flex items-start gap-3.5 p-4 rounded-xl border border-border bg-card/40 hover:bg-card/70 transition-colors"
            >
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="h-4.5 w-4.5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">{title}</p>
                <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
