import { useEffect, useRef } from 'react';
import { Shield, Lock, Eye, Scale, FileCheck, RotateCcw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { track } from '@/lib/track';

interface Principle {
  icon: typeof Shield;
  title: string;
  description: string;
}

const principles: Principle[] = [
  {
    icon: Lock,
    title: 'Rules Published at Purchase',
    description:
      'Your evaluation rules are locked at the time of purchase and versioned. No mid-challenge surprises.',
  },
  {
    icon: Eye,
    title: 'Staff-Reviewed Decisions',
    description:
      'Breach flags and payout requests are reviewed by staff before any action is taken — not just an algorithm.',
  },
  {
    icon: Scale,
    title: 'Caps Disclosed Upfront',
    description:
      'Lifetime payout caps and split percentages are shown on the pricing page before you buy. No hidden limits.',
  },
  {
    icon: FileCheck,
    title: 'Decisions Logged',
    description:
      'Key actions are recorded with timestamps so they can be referenced if questions arise.',
  },
  {
    icon: Shield,
    title: 'Simulated Environment',
    description:
      'All trading is simulated. Payouts are performance-based rewards, not profit withdrawals or investment returns.',
  },
  {
    icon: RotateCcw,
    title: '$99 Reset, Same Rules',
    description:
      'If you breach your account, reset for a flat fee. Same tier, same published rules, fresh start.',
  },
];

export function Testimonials() {
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('testimonial_view');
    }
  }, []);

  return (
    <section className="py-20 lg:py-28 border-t border-border bg-card/30">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 text-sm text-primary font-semibold uppercase tracking-wider mb-4">
            <Shield className="h-4 w-4" />
            Our Commitments
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">What We Stand For</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Six principles that define how we operate. Every one is enforced in the platform.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {principles.map((p) => (
            <Card key={p.title} className="border-border bg-card/60">
              <CardContent className="p-6">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <p.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground mb-2">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {p.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
