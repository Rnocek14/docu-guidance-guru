import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PricingTier {
  id: string;
  name: string;
  price: number;
  accountSize: string;
  firstPayoutCap: number;
  splitPercent: number;
  lifetimeCapMultiple: number;
  lifetimeCapAmount: number;
  popular?: boolean;
  features: string[];
}

interface TierCardProps {
  tier: PricingTier;
  isSelected: boolean;
  onSelect: () => void;
}

export function TierCard({ tier, isSelected, onSelect }: TierCardProps) {
  return (
    <Card
      className={cn(
        "relative cursor-pointer transition-all duration-150",
        "hover:border-primary/50 hover:shadow-md",
        isSelected
          ? "border-primary ring-2 ring-primary/20 shadow-lg"
          : "border-border"
      )}
      onClick={onSelect}
    >
      {tier.popular && (
        <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
          Most Popular
        </Badge>
      )}
      <CardContent className="pt-6 pb-5 px-5 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-foreground">{tier.name}</h3>
          <p className="text-muted-foreground text-sm">
            {tier.accountSize} simulated account
          </p>
        </div>

        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-foreground">
            ${tier.price}
          </span>
          <span className="text-muted-foreground text-sm">one-time</span>
        </div>

        <ul className="space-y-2">
          {tier.features.map((feature, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
              <span className="text-muted-foreground">{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
