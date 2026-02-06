import { Checkbox } from "@/components/ui/checkbox";
import { Shield } from "lucide-react";

interface CheckoutDisclaimerProps {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}

/**
 * MANDATORY CHECKOUT DISCLAIMER — P0 RELEASE BLOCKER
 * 
 * This component MUST be rendered immediately above the payment button
 * on any checkout or purchase flow. It is the single highest-leverage
 * risk reducer in the system:
 * 
 * - Satisfies payment processor (Wise/Stripe) risk review
 * - Defangs "I thought this was investing" chargebacks
 * - Reduces regulator curiosity by an order of magnitude
 * - Neutralizes ambiguity about what the user is purchasing
 * 
 * DO NOT:
 * - Hide this behind a collapsible/accordion
 * - Make the checkbox optional
 * - Allow purchase without explicit acceptance
 * - Soften or reword the language without legal review
 */
export function CheckoutDisclaimer({
  accepted,
  onAcceptedChange,
}: CheckoutDisclaimerProps) {
  return (
    <div className="rounded-lg border-2 border-warning/40 bg-warning/5 p-4 space-y-3">
      <div className="flex items-start gap-2.5">
        <Shield className="h-5 w-5 text-warning mt-0.5 shrink-0" />
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">
            Important — Please read before purchasing
          </p>
          <div className="text-sm text-muted-foreground leading-relaxed space-y-2">
            <p>
              You are purchasing access to a{" "}
              <span className="font-medium text-foreground">
                simulated trading evaluation
              </span>
              . No real capital is traded or allocated to your account.
            </p>
            <p>
              Payouts are{" "}
              <span className="font-medium text-foreground">
                performance-based rewards
              </span>{" "}
              subject to eligibility rules, caps, and review — not profit
              withdrawals from a trading account.
            </p>
            <p>
              All trading activity occurs in a simulated environment. You will
              not have access to real markets, real capital, or real brokerage
              services.
            </p>
          </div>
        </div>
      </div>

      <label className="flex items-start gap-3 cursor-pointer pt-1 border-t border-warning/20">
        <Checkbox
          checked={accepted}
          onCheckedChange={(checked) =>
            onAcceptedChange(checked === true)
          }
          className="mt-0.5"
        />
        <span className="text-sm text-foreground leading-snug">
          I understand that this is a simulated evaluation, not an investment
          product, and that payouts are performance-based rewards subject to
          the platform's{" "}
          <a
            href="/terms"
            target="_blank"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            Terms of Service
          </a>
          .
        </span>
      </label>
    </div>
  );
}
