import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Shield, ArrowRight, Check, RotateCcw } from 'lucide-react';
import { Hero } from '@/components/landing/Hero';
import { SocialProofBar } from '@/components/landing/SocialProofBar';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { PricingSection } from '@/components/landing/PricingSection';
import { Differentiators } from '@/components/landing/Differentiators';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

const compareItems = [
  { label: 'Rules frozen at purchase', us: true },
  { label: 'Human review (never auto-deny)', us: true },
  { label: 'Full audit trail on every decision', us: true },
  { label: 'Lifetime caps disclosed upfront', us: true },
];

export default function Index() {
  // Force dark mode on the landing page
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    root.classList.add('dark');
    return () => {
      if (!hadDark) root.classList.remove('dark');
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navigation */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-7 w-7 text-primary" />
            <span className="text-lg font-bold">RiskAnalytics</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
            <Link to="/rules" className="hover:text-foreground transition-colors">Rules</Link>
            <a href="#faq" className="hover:text-foreground transition-colors">FAQ</a>
          </nav>
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Sign In</Link>
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <Link to="/checkout">
                Get Started <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <Hero />
      <SocialProofBar />
      <HowItWorks />
      <PricingSection />

      {/* Reset / Retry Card */}
      <section className="py-16 border-t border-border">
        <div className="container mx-auto px-4 max-w-2xl">
          <Card className="border-border bg-card/60">
            <CardContent className="flex flex-col sm:flex-row items-start gap-5 p-6">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <RotateCcw className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-1">What If I Fail?</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                  It happens. If you breach a rule, your account is flagged for human review — not
                  auto-failed. If confirmed, you can reset for <strong>$99</strong> and start fresh
                  with the same tier and rules. No waiting period. No penalty beyond the reset fee.
                </p>
                <Link to="/rules" className="text-sm text-primary font-medium hover:underline">
                  Read the full rules →
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Compare Row */}
      <section className="py-16 border-t border-border bg-card/30">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-8">
            What Sets Us Apart
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {compareItems.map(({ label }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
              >
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Check className="h-4 w-4 text-primary" />
                </div>
                <span className="text-sm font-medium">{label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center mt-6">
            We prioritize long-term solvency and fairness over aggressive acquisition tactics.
          </p>
        </div>
      </section>

      <Differentiators />

      <section id="faq">
        <FAQ />
      </section>

      {/* Final CTA — dual buttons */}
      <section className="py-20 lg:py-28 border-t border-border">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Ready to Prove Your Skill?</h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-xl mx-auto">
            Join traders on the fairest simulated trading evaluation platform.
            Transparent rules. Human decisions. Clear caps.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button asChild size="lg" className="gap-2 h-12 px-8 text-base font-semibold">
              <Link to="/checkout?tier=pro">
                Start Pro Evaluation <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-8 text-base">
              <a href="#pricing">
                View All Plans
              </a>
            </Button>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
