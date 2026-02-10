import { useEffect, useRef } from 'react';
import { track } from '@/lib/track';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Shield, ArrowRight, RotateCcw, Lock, Users, FileText } from 'lucide-react';
import { PromoBanner } from '@/components/landing/PromoBanner';
import { Hero } from '@/components/landing/Hero';
import { StatsCounter } from '@/components/landing/StatsCounter';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { PricingSection } from '@/components/landing/PricingSection';
import { ComparisonTable } from '@/components/landing/ComparisonTable';
import { Testimonials } from '@/components/landing/Testimonials';
import { PlatformLogos } from '@/components/landing/PlatformLogos';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

export default function Index() {
  const tracked = useRef(false);

  // Force dark mode on the landing page
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    root.classList.add('dark');
    if (!tracked.current) { tracked.current = true; track('lp_view'); }
    return () => {
      if (!hadDark) root.classList.remove('dark');
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Promo Banner */}
      <PromoBanner />

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
            <a href="#compare" className="hover:text-foreground transition-colors">Compare</a>
            <a href="#faq" className="hover:text-foreground transition-colors">FAQ</a>
          </nav>
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Sign In</Link>
            </Button>
            <Button asChild size="sm" className="gap-1.5" onClick={() => track('lp_click_cta', { cta: 'nav_get_started' })}>
              <Link to="/checkout">
                Get Started <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <Hero />
      <StatsCounter />
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
                  It happens. If you breach a rule, your account is flagged for review — outcomes are
                  confirmed by staff. If your account is closed, you can typically reset for{' '}
                  <strong>$99</strong> and start fresh with the same tier and rules.
                </p>
                <Link to="/rules" className="text-sm text-primary font-medium hover:underline">
                  Read the full rules →
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="compare">
        <ComparisonTable />
      </section>

      <Testimonials />
      <PlatformLogos />

      <section id="faq">
        <FAQ />
      </section>

      {/* Final CTA — with mini recap */}
      <section className="py-20 lg:py-28 border-t border-border">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Ready to Prove Your Skill?</h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-xl mx-auto">
            Join traders on the fairest simulated trading evaluation platform.
          </p>

          {/* Mini recap bullets */}
          <div className="flex flex-wrap justify-center gap-6 mb-10 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Lock className="h-4 w-4 text-primary" /> Rules frozen at purchase
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-primary" /> Human-reviewed decisions
            </span>
            <span className="flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-primary" /> Full audit trail
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button asChild size="lg" className="gap-2 h-12 px-8 text-base font-semibold" onClick={() => track('lp_click_cta', { cta: 'final_primary', tier: 'pro' })}>
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
