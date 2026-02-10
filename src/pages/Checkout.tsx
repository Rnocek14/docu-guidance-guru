import { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import { CheckoutDisclaimer } from "@/components/checkout/CheckoutDisclaimer";
import { TierCard } from "@/components/checkout/TierCard";
import { OrderSummary } from "@/components/checkout/OrderSummary";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { TIERS } from "@/lib/pricing-data";

// Map shared pricing data to checkout TierCard format
const CHECKOUT_TIERS = TIERS.map((t) => ({
  id: t.id,
  name: t.name,
  price: t.price,
  accountSize: t.accountSize,
  firstPayoutCap: t.firstPayoutCap,
  splitPercent: t.splitPercent,
  lifetimeCapMultiple: t.lifetimeCapMultiple,
  popular: t.popular,
  features: [
    `Simulated ${t.accountSize} trading account`,
    `$${t.firstPayoutCap} first payout milestone`,
    `${t.splitPercent}% payout rate on eligible rewards`,
    `${t.lifetimeCapMultiple}× lifetime cap ($${t.lifetimeCapAmount.toLocaleString()} max)`,
    `$${t.resetFee} reset fee if needed`,
  ],
}));

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTier =
    searchParams.get("tier") && CHECKOUT_TIERS.some((t) => t.id === searchParams.get("tier"))
      ? searchParams.get("tier")!
      : "pro";
  const [selectedTier, setSelectedTier] = useState<string>(initialTier);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const tier = CHECKOUT_TIERS.find((t) => t.id === selectedTier)!;

  // Sync state when URL changes (back/forward nav, manual edits)
  useEffect(() => {
    const t = searchParams.get("tier");
    if (t && CHECKOUT_TIERS.some((x) => x.id === t) && t !== selectedTier) {
      setSelectedTier(t);
    }
  }, [searchParams]);

  const handleSelectTier = (id: string) => {
    setSelectedTier(id);
    setSearchParams({ tier: id }, { replace: true });
  };

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
            onClick={() => navigate("/#pricing")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Plans
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
            {CHECKOUT_TIERS.map((t) => (
              <TierCard
                key={t.id}
                tier={t}
                isSelected={selectedTier === t.id}
                onSelect={() => handleSelectTier(t.id)}
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
            Secure payment processed by Stripe. Refund eligibility is subject to
            our <Link to="/rules" className="underline hover:text-foreground">refund policy</Link>.
          </p>
        </section>
      </main>
    </div>
  );
}
