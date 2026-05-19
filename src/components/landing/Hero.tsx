import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Shield, Lock, Eye, Scale } from 'lucide-react';
import { track } from '@/lib/track';
import { HeroDashboardPreview } from './HeroDashboardPreview';

const badges = [
  { icon: Lock, label: 'Published Rules' },
  { icon: Eye, label: 'Staff-Reviewed' },
  { icon: Scale, label: 'Decisions Logged' },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-20 pb-8 lg:pt-32 lg:pb-12">
      {/* Animated background gradient effects */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[600px] rounded-full bg-primary/5 blur-3xl animate-pulse" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full bg-primary/3 blur-3xl" />
        <div className="absolute top-0 right-0 w-[300px] h-[300px] rounded-full bg-primary/4 blur-3xl animate-pulse [animation-delay:2s]" />
      </div>

      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto text-center">
          {/* Tagline badge — prominent */}
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 backdrop-blur px-4 py-1.5 text-sm font-semibold text-primary mb-6 animate-in fade-in slide-in-from-bottom-2 duration-700">
            <Shield className="h-4 w-4" />
            Your Fixed Point in Trading.
          </div>

          {/* Badge row */}
          <div className="flex flex-wrap justify-center gap-3 mb-8 animate-in fade-in slide-in-from-bottom-3 duration-700 [animation-delay:150ms]">
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

          <h1 className="text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:300ms]">
            Pass the Evaluation.
            <br />
            <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Earn Real Payouts.
            </span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:450ms]">
            A rules-based evaluation for serious traders. Prove your skill on a simulated account,
            earn performance-based rewards in real cash. Published rules, staff-reviewed decisions,
            no mid-challenge changes.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:600ms]">
            <Button asChild size="lg" className="gap-2 h-12 px-8 text-base font-semibold" onClick={() => track('lp_click_cta', { cta: 'hero_primary' })}>
              <a href="#pricing">
                Start Your Evaluation <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-8 text-base">
              <Link to="/rules" onClick={() => track('lp_click_rules', { location: 'hero' })}>View Rules</Link>
            </Button>
            <p className="text-xs text-muted-foreground -mt-1">Read in 2 minutes</p>
          </div>

          <p className="text-xs text-muted-foreground mt-4 animate-in fade-in duration-700 [animation-delay:750ms]">
            Simulated evaluation · transparent caps · staff-reviewed decisions
          </p>
        </div>

        {/* Dashboard Preview */}
        <HeroDashboardPreview />
      </div>
    </section>
  );
}
