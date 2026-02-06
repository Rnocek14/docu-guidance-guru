import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Shield, TrendingUp, Users, Eye, ArrowRight } from 'lucide-react';

export default function Index() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-8 w-8 text-primary" />
            <span className="text-xl font-bold">RiskAnalytics</span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/login">
              <Button variant="ghost">Sign in</Button>
            </Link>
            <Link to="/signup">
              <Button>Get Started</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 lg:py-32">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl lg:text-6xl font-bold tracking-tight mb-6">
            Simulated Trading Evaluation
            <br />
            <span className="text-primary">Done Right</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            Real-time detection. Human-approved decisions. Complete transparency.
            <br />
            <strong>Detection, Not Domination.</strong>
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/signup">
              <Button size="lg" className="gap-2">
                Start Your Challenge <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link to="/login">
              <Button size="lg" variant="outline">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 bg-muted/50">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">
            Built for Fair Evaluation
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="bg-card p-6 rounded-lg border">
              <TrendingUp className="h-10 w-10 text-primary mb-4" />
              <h3 className="text-xl font-semibold mb-2">Real-Time Monitoring</h3>
              <p className="text-muted-foreground">
                Track your drawdown, P&L, and progress in real-time. Get proactive warnings
                before you hit limits, not surprise failures.
              </p>
            </div>
            <div className="bg-card p-6 rounded-lg border">
              <Users className="h-10 w-10 text-primary mb-4" />
              <h3 className="text-xl font-semibold mb-2">Human-in-the-Loop</h3>
              <p className="text-muted-foreground">
                AI never denies payouts or locks accounts automatically. Every terminal
                decision requires human review and approval.
              </p>
            </div>
            <div className="bg-card p-6 rounded-lg border">
              <Eye className="h-10 w-10 text-primary mb-4" />
              <h3 className="text-xl font-semibold mb-2">Full Transparency</h3>
              <p className="text-muted-foreground">
                Complete audit trail for every decision. Your rules are locked when you
                start—no mid-challenge changes.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to Prove Your Skill?</h2>
          <p className="text-muted-foreground mb-8">
            Join thousands of traders on the fairest simulated trading evaluation platform.
          </p>
          <Link to="/signup">
            <Button size="lg">Create Your Account</Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="container mx-auto px-4 text-center text-muted-foreground">
          <p>© 2026 RiskAnalytics. Detection, Not Domination.</p>
        </div>
      </footer>
    </div>
  );
}
