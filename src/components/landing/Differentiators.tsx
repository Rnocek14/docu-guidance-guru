import { Lock, Users, FileText, ShieldCheck } from 'lucide-react';

const items = [
  {
    icon: Lock,
    title: 'Frozen Rules',
    description:
      'Your evaluation rules are locked the moment you start. No mid-challenge changes. What you signed up for is what you get.',
  },
  {
    icon: Users,
    title: 'Human-In-The-Loop',
    description:
      'AI flags — humans decide. No algorithm auto-denies payouts or locks your account. Every terminal decision requires human review.',
  },
  {
    icon: FileText,
    title: 'Full Audit Trail',
    description:
      'Every trade, every rule check, every decision is logged with a complete audit trail. Total transparency, always.',
  },
  {
    icon: ShieldCheck,
    title: 'Clear Caps, No Surprises',
    description:
      'Lifetime payout caps are disclosed upfront. You know exactly what you can earn before you start. No hidden ceilings.',
  },
];

export function Differentiators() {
  return (
    <section className="py-20 lg:py-28 border-t border-border bg-card/30">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Why Choose Us</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Built for traders who want fairness, not gimmicks.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
          {items.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-6">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-2">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
