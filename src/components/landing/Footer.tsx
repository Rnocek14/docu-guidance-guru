import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-border py-12">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" />
            <span className="font-bold">RiskAnalytics</span>
          </div>
          <nav className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground">
            <Link to="/rules" className="hover:text-foreground transition-colors">
              Rules
            </Link>
            <a href="#pricing" className="hover:text-foreground transition-colors">
              Pricing
            </a>
            <a href="#faq" className="hover:text-foreground transition-colors">
              FAQ
            </a>
            <Link to="/login" className="hover:text-foreground transition-colors">
              Sign In
            </Link>
            <a href="mailto:support@riskanalytics.com" className="hover:text-foreground transition-colors">
              Contact
            </a>
          </nav>
        </div>
        <div className="mt-8 pt-6 border-t border-border text-center space-y-2">
          <p className="text-xs text-muted-foreground max-w-2xl mx-auto">
            All trading activity is simulated. Payouts are performance-based rewards, not profit
            withdrawals or investment returns. This is not a brokerage, investment service, or
            financial advice.
          </p>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} RiskAnalytics. Detection, Not Domination.
          </p>
        </div>
      </div>
    </footer>
  );
}
