import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import { CheckoutDisclaimer } from "@/components/checkout/CheckoutDisclaimer";
import { TierCard, type PricingTier } from "@/components/checkout/TierCard";
import { OrderSummary } from "@/components/checkout/OrderSummary";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const TIERS: PricingTier[] = [
  {
    id: "starter",
    name: "Starter",
    price: 149,
    accountSize: "$50,000",
    firstPayoutCap: 300,
    splitPercent: 80,
    lifetimeCapMultiple: 7,
    features: [
      "Simulated $50k trading account",
      "$300 first payout milestone",
      "80% payout rate on eligible rewards",
      "7× lifetime cap ($1,043 max)",
      "$99 reset fee if needed",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: 199,
    accountSize: "$100,000",
    firstPayoutCap: 500,
    splitPercent: 82,
    lifetimeCapMultiple: 9,
    popular: true,
    features: [
      "Simulated $100k trading account",
      "$500 first payout milestone",
      "82% payout rate on eligible rewards",
      "9× lifetime cap ($1,791 max)",
      "$99 reset fee if needed",
    ],
  },
  {
    id: "elite",
    name: "Elite",
    price: 349,
    accountSize: "$200,000",
    firstPayoutCap: 750,
    splitPercent: 85,
    lifetimeCapMultiple: 12,
    features: [
      "Simulated $200k trading account",
      "$750 first payout milestone",
      "85% payout rate on eligible rewards",
      "12× lifetime cap ($4,188 max)",
      "$99 reset fee if needed",
    ],
  },
];

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selectedTier, setSelectedTier] = useState<string>(
    searchParams.get("tier") && TIERS.some((t) => t.id === searchParams.get("tier"))
      ? searchParams.get("tier")!
      : "pro"
  );
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const tier = TIERS.find((t) => t.id === selectedTier)!;

  const handlePurchase = async () => {
    if (!disclaimerAccepted) return;
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { tierId: selectedTier, disclaimerAccepted: true },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error('Checkout error:', err);
      toast.error('Failed to start checkout. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <h1 className="text-lg font-semibold text-foreground">
            Start Your Evaluation
          </h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* Step 1: Choose tier */}
        <section>
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-foreground">
              Choose Your Evaluation Tier
            </h2>
            <p className="text-muted-foreground mt-1">
              Select the simulated account size for your trading evaluation.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {TIERS.map((t) => (
              <TierCard
                key={t.id}
                tier={t}
                isSelected={selectedTier === t.id}
                onSelect={() => setSelectedTier(t.id)}
              />
            ))}
          </div>
        </section>

        {/* Step 2: Order summary + disclaimer + pay */}
        <section className="max-w-lg mx-auto space-y-6">
          <OrderSummary tier={tier} />

          {/* ═══════════════════════════════════════════════════════
              MANDATORY DISCLAIMER — P0 RELEASE BLOCKER
              This block MUST appear immediately above the pay button.
              Do not move, hide, collapse, or gate behind a toggle.
              ═══════════════════════════════════════════════════════ */}
          <CheckoutDisclaimer
            accepted={disclaimerAccepted}
            onAcceptedChange={setDisclaimerAccepted}
          />

          {/* Pay button */}
          <Button
            className="w-full h-12 text-base font-semibold"
            size="lg"
            disabled={!disclaimerAccepted || isProcessing}
            onClick={handlePurchase}
          >
            {isProcessing ? (
              "Processing…"
            ) : (
              <>
                Pay ${tier.price.toLocaleString()} — Start Evaluation
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            Secure payment processed by Stripe. You can request a refund within
            48 hours if you haven't placed any trades.
          </p>
        </section>
      </main>
    </div>
  );
}
