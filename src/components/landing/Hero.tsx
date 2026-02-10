import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Shield, Lock, Eye, Scale } from 'lucide-react';

const badges = [
  { icon: Lock, label: 'Frozen Rules' },
  { icon: Eye, label: 'Human-In-The-Loop' },
  { icon: Scale, label: 'Full Audit Trail' },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-20 pb-28 lg:pt-32 lg:pb-40">
      {/* Background gradient effects */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[600px] rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full bg-primary/3 blur-3xl" />
      </div>

      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge row */}
          <div className="flex flex-wrap justify-center gap-3 mb-8">
            {badges.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 backdrop-blur px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                <Icon className="h-3 w-3 text-primary" />
                {label}
              </span>
            ))}
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6">
            Simulated Trading
            <br />
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Evaluation Done Right
            </span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-4">
            Prove your skill on a simulated account. Meet the rules. Earn performance-based rewards.
            No hidden catches.
          </p>
          <p className="text-sm font-semibold text-foreground/80 mb-10 tracking-wide uppercase">
            Detection, Not Domination.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button asChild size="lg" className="gap-2 h-12 px-8 text-base font-semibold">
              <a href="#pricing">
                Start Your Evaluation <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-8 text-base">
              <Link to="/login">Sign In</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
