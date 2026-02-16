import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Shield, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { TIERS } from '@/lib/pricing-data';
import { cn } from '@/lib/utils';
import { Footer } from '@/components/landing/Footer';

const evaluationRules = [
  { label: 'Profit Target', description: 'You must reach the profit target percentage on your simulated account to pass the evaluation.' },
  { label: 'Max Daily Loss', description: 'Your daily simulated P&L cannot fall below the max daily loss threshold on any single day.' },
  { label: 'Max Total Drawdown', description: 'Your account equity cannot drawdown below the maximum total drawdown threshold from your highest balance.' },
  { label: 'Minimum Trading Days', description: 'You must trade on at least the minimum number of distinct trading days before you are eligible to pass.' },
];

const verificationRules = [
  { label: 'Verification Profit Target', description: 'A reduced profit target confirms consistent performance before advancing to the Performance phase.' },
  { label: 'Minimum Trading Days', description: 'You must trade on at least the required number of distinct days during Verification.' },
  { label: 'Minimum Profitable Days', description: 'A minimum number of your trading days must be profitable to demonstrate consistency.' },
  { label: 'Best-Day Cap', description: "No single trading day's profit may exceed a set percentage of total profit, preventing reliance on one outsized win." },
];

const performanceRules = [
  { label: 'Payout Cooldown', description: 'After each payout, you must wait the cooldown period (30 days) before requesting another.' },
  { label: 'First Payout Cap', description: 'Your first payout request is capped at a fixed dollar amount, which varies by tier.' },
  { label: 'Payout Split', description: 'You receive a percentage of your eligible simulated profit as a performance-based reward.' },
  { label: 'Lifetime Cap', description: 'Each account has a maximum total payout amount (a multiple of your entry fee). Once reached, the account is closed.' },
  { label: 'Winning Days Requirement', description: 'A minimum number of profitable trading days is required between payout requests.' },
  { label: 'Profit Buffer', description: 'Accounts must maintain a minimum profit buffer above the payout amount to remain eligible.' },
  { label: 'Human Review', description: 'Every payout request and account breach is reviewed by a human risk officer. AI does not auto-deny.' },
];

function RuleList({ rules }: { rules: { label: string; description: string }[] }) {
  return (
    <div className="space-y-4">
      {rules.map((rule) => (
        <Card key={rule.label}>
          <CardContent className="flex items-start gap-4 py-4">
            <Check className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{rule.label}</p>
              <p className="text-sm text-muted-foreground">{rule.description}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function Rules() {
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    root.classList.add('dark');
    return () => { if (!hadDark) root.classList.remove('dark'); };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <Shield className="h-7 w-7 text-primary" />
            <span className="text-lg font-bold">Meridian</span>
          </Link>
          <Button asChild size="sm" className="gap-1.5">
            <Link to="/checkout">
              Start Evaluation <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 max-w-4xl space-y-12">
        <div>
          <Button asChild variant="ghost" size="sm" className="gap-1.5 mb-6">
            <Link to="/"><ArrowLeft className="h-4 w-4" /> Back</Link>
          </Button>
          <h1 className="text-4xl font-bold mb-4">Evaluation Rules</h1>
          <p className="text-muted-foreground text-lg">
            Complete transparency. These are the exact rules your account is evaluated against.
            Rules are published at purchase. Changes, if any, are announced in advance.
          </p>
        </div>

        {/* Phase 1: Evaluation */}
        <section>
          <h2 className="text-2xl font-bold mb-6">Phase 1 — Evaluation</h2>
          <RuleList rules={evaluationRules} />
        </section>

        {/* Phase 2: Verification */}
        <section>
          <h2 className="text-2xl font-bold mb-6">Phase 2 — Verification</h2>
          <RuleList rules={verificationRules} />
        </section>

        {/* Phase 3: Performance */}
        <section>
          <h2 className="text-2xl font-bold mb-6">Phase 3 — Performance</h2>
          <RuleList rules={performanceRules} />
        </section>

        {/* Tier Comparison Table */}
        <section>
          <h2 className="text-2xl font-bold mb-6">Rules by Tier</h2>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left p-4 text-muted-foreground font-medium">Rule</th>
                    {TIERS.map((t) => (
                      <th key={t.id} className={cn("text-center p-4 font-medium", !t.isLive && "bg-muted/30")}>
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          {t.name}
                          {t.isLive && t.popular && (
                            <Badge variant="secondary" className="text-xs">Popular</Badge>
                          )}
                          {!t.isLive && (
                            <Badge variant="outline" className="text-xs text-muted-foreground">Upcoming</Badge>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Account Size', render: (t: typeof TIERS[0]) => t.accountSize },
                    { label: 'Entry Fee', render: (t: typeof TIERS[0]) => `$${t.price}` },
                    { label: 'Profit Target', render: (t: typeof TIERS[0]) => `${t.profitTarget}%` },
                    { label: 'Max Daily Loss', render: (t: typeof TIERS[0]) => `${t.maxDailyLoss}%` },
                    { label: 'Max Drawdown', render: (t: typeof TIERS[0]) => `${t.maxTotalDrawdown}%` },
                    { label: 'Min Trading Days', render: (t: typeof TIERS[0]) => `${t.minTradingDays}` },
                    { label: 'Payout Split', render: (t: typeof TIERS[0]) => `${t.splitPercent}%` },
                    { label: 'First Payout Cap', render: (t: typeof TIERS[0]) => `$${t.firstPayoutCap}` },
                    { label: 'Lifetime Cap', render: (t: typeof TIERS[0]) => `$${t.lifetimeCapAmount.toLocaleString()}` },
                    { label: 'Cooldown', render: (t: typeof TIERS[0]) => `${t.payoutCooldown} days` },
                    { label: 'Reset Fee', render: (t: typeof TIERS[0]) => `$${t.resetFee}` },
                  ].map((row) => (
                    <tr key={row.label} className="border-b border-border last:border-0">
                      <td className="p-4 text-muted-foreground">{row.label}</td>
                      {TIERS.map((t) => (
                        <td key={t.id} className="p-4 text-center font-medium">{row.render(t)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground mt-3">
            Pro and Elite are planned tiers and not yet available for purchase. Values shown reflect intended criteria and may be updated prior to launch.
          </p>
        </section>

        {/* Refunds */}
        <section id="refunds" className="scroll-mt-24">
          <h2 className="text-2xl font-bold mb-6">Refund Policy</h2>
          <Card>
            <CardContent className="py-6 space-y-3 text-sm text-muted-foreground">
              <ul className="space-y-2 list-disc list-inside">
                <li>Refund eligibility depends on account status and policy conditions at time of purchase.</li>
                <li>If you believe you're eligible, contact support with your order email.</li>
                <li>Refunds may be denied in cases of rule abuse, chargeback risk, or policy violations.</li>
                <li>Approved refunds are returned to the original payment method when possible.</li>
                <li>We do not provide cash refunds outside of the payment processor's supported methods.</li>
              </ul>
              <p className="pt-2 text-xs">
                For full terms, see our{' '}
                <Link to="/terms" className="underline hover:text-foreground">Terms of Service</Link>.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* CTA */}
        <div className="text-center py-8">
          <Button asChild size="lg" className="gap-2">
            <Link to="/checkout">
              Start Your Evaluation <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </main>

      <Footer />
    </div>
  );
}
