import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { PricingTier } from "./TierCard";

interface OrderSummaryProps {
  tier: PricingTier;
}

export function OrderSummary({ tier }: OrderSummaryProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Order Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {tier.name} Evaluation — {tier.accountSize} simulated
          </span>
          <span className="font-medium text-foreground">
            ${tier.price.toLocaleString()}
          </span>
        </div>
        <Separator />
        <div className="flex justify-between text-sm font-semibold">
          <span className="text-foreground">Total</span>
          <span className="text-foreground">
            ${tier.price.toLocaleString()} USD
          </span>
        </div>
        <div className="text-xs text-muted-foreground space-y-1 pt-1">
          <p>• Payout rate: {tier.splitPercent}% of eligible rewards</p>
          <p>• First payout: up to ${tier.firstPayoutCap}</p>
          <p>• Lifetime earnings: up to {tier.lifetimeCapMultiple}× your entry fee (${tier.lifetimeCapAmount.toLocaleString()})</p>
          <p>• Drawdown: 10% end-of-day trailing, locks at starting balance</p>
          <p>• Payout review SLA: 1–3 business days (max 5 if flagged)</p>
          <p>• Reset fee: $99 (optional, if evaluation is failed)</p>
        </div>
      </CardContent>
    </Card>
  );
}
