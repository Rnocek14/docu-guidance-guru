import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, ArrowRight } from 'lucide-react';
import { TIERS, type PricingTier } from '@/lib/pricing-data';
import { cn } from '@/lib/utils';

function TierCard({ tier }: { tier: PricingTier }) {
  const isPopular = tier.popular;
  return (
    <Card
      className={cn(
        'relative flex flex-col transition-all',
        isPopular
          ? 'border-primary shadow-lg shadow-primary/10 scale-[1.02]'
          : 'border-border hover:border-primary/40'
      )}
    >
      {isPopular && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4">
          Most Popular
        </Badge>
      )}
      <CardHeader className="text-center pb-2 pt-8">
        <CardTitle className="text-lg font-medium text-muted-foreground">{tier.name}</CardTitle>
        <div className="mt-2">
          <span className="text-5xl font-extrabold">${tier.price}</span>
          <span className="text-muted-foreground ml-1">one-time</span>
        </div>
        <p className="text-sm text-primary font-medium mt-2">{tier.accountSize} Simulated Account</p>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pt-4">
        <div className="space-y-3 flex-1">
          <RuleRow label="Profit Target" value={`${tier.profitTarget}%`} />
          <RuleRow label="Max Daily Loss" value={`${tier.maxDailyLoss}%`} />
          <RuleRow label="Max Drawdown" value={`${tier.maxTotalDrawdown}%`} />
          <RuleRow label="Min Trading Days" value={`${tier.minTradingDays}`} />
          <RuleRow label="Payout Split" value={`${tier.splitPercent}%`} highlight />
          <RuleRow label="First Payout Cap" value={`$${tier.firstPayoutCap}`} />
          <RuleRow label="Lifetime Cap" value={`$${tier.lifetimeCapAmount.toLocaleString()}`} />
          <RuleRow label="Reset Fee" value={`$${tier.resetFee}`} />
        </div>
        <Button
          asChild
          className={cn('w-full mt-6 gap-2', isPopular ? '' : 'variant-outline')}
          variant={isPopular ? 'default' : 'outline'}
          size="lg"
        >
          <Link to={`/checkout?tier=${tier.id}`}>
            Get Started <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function RuleRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground flex items-center gap-2">
        <Check className="h-3.5 w-3.5 text-primary shrink-0" />
        {label}
      </span>
      <span className={cn('font-medium', highlight && 'text-primary')}>{value}</span>
    </div>
  );
}

export function PricingSection() {
  return (
    <section id="pricing" className="py-20 lg:py-28 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Choose Your Evaluation</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Simple pricing. Transparent rules. Every tier uses the same evaluation criteria.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {TIERS.map((tier) => (
            <TierCard key={tier.id} tier={tier} />
          ))}
        </div>

        <p className="text-xs text-muted-foreground text-center mt-8 max-w-2xl mx-auto">
          All trading activity is simulated. Payouts are performance-based rewards, not profit withdrawals
          or investment returns. Rules are locked at the time of purchase and cannot be changed mid-evaluation.
        </p>
      </div>
    </section>
  );
}
