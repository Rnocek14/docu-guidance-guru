import { CreditCard, Target, DollarSign } from 'lucide-react';

const steps = [
  {
    icon: CreditCard,
    title: 'Choose Your Plan',
    description: 'Pick a simulated account size that fits your trading style. Starter, Pro, or Elite.',
  },
  {
    icon: Target,
    title: 'Pass the Evaluation',
    description: 'Trade within the rules. Hit the profit target with minimum trading days. Rules are frozen at start.',
  },
  {
    icon: DollarSign,
    title: 'Earn Rewards',
    description: 'Request your performance-based payout. Every decision is human-reviewed — never auto-denied.',
  },
];

export function HowItWorks() {
  return (
    <section className="py-20 lg:py-28 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">How It Works</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Three steps from signup to payout. No hidden rules. No surprises.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto relative">
          {/* Connector line (desktop only) */}
          <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-px bg-border" />

          {steps.map((step, i) => (
            <div key={step.title} className="relative text-center">
              {/* Step number circle */}
              <div className="mx-auto mb-6 relative">
                <div className="w-24 h-24 rounded-2xl bg-card border border-border flex items-center justify-center mx-auto shadow-sm">
                  <step.icon className="h-10 w-10 text-primary" />
                </div>
                <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
              </div>
              <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
