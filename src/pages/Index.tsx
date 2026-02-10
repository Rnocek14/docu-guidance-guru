import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Shield, ArrowRight } from 'lucide-react';
import { Hero } from '@/components/landing/Hero';
import { SocialProofBar } from '@/components/landing/SocialProofBar';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { PricingSection } from '@/components/landing/PricingSection';
import { Differentiators } from '@/components/landing/Differentiators';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

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
      <Differentiators />
      <section id="faq">
        <FAQ />
      </section>

      {/* Final CTA */}
      <section className="py-20 lg:py-28 border-t border-border">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Ready to Prove Your Skill?</h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-xl mx-auto">
            Join traders on the fairest simulated trading evaluation platform.
            Transparent rules. Human decisions. Clear caps.
          </p>
          <Button asChild size="lg" className="gap-2 h-12 px-8 text-base font-semibold">
            <a href="#pricing">
              View Plans <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </section>

      <Footer />
    </div>
  );
}
