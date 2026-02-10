import { useState, useEffect, useRef } from "react";
import { track } from "@/lib/track";
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
  lifetimeCapAmount: t.lifetimeCapAmount,
  popular: t.popular,
  isLive: t.isLive,
  features: [
    `Simulated ${t.accountSize} trading account`,
    `Up to $${t.firstPayoutCap} first payout`,
    `${t.splitPercent}% payout rate on eligible rewards`,
    `Up to ${t.lifetimeCapMultiple}× your entry in lifetime earnings`,
    `$${t.resetFee} reset fee if needed`,
  ],
}));

const LIVE_CHECKOUT_TIERS = CHECKOUT_TIERS.filter((t) => t.isLive);
const DEFAULT_TIER = LIVE_CHECKOUT_TIERS[0]?.id ?? "starter";

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTier = searchParams.get("tier");
  const initialTier =
    urlTier && LIVE_CHECKOUT_TIERS.some((t) => t.id === urlTier)
      ? urlTier
      : DEFAULT_TIER;
  const [selectedTier, setSelectedTier] = useState<string>(initialTier);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const tracked = useRef(false);

  const tier = CHECKOUT_TIERS.find((t) => t.id === selectedTier)!;

  // Track checkout view once
  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('checkout_view', { tier: initialTier, is_live: LIVE_CHECKOUT_TIERS.some(t => t.id === initialTier) });
    }
  }, [initialTier]);

  // Normalize URL if tier param is non-live (stale bookmark/deep link)
  useEffect(() => {
    const t = searchParams.get("tier");
    if (t && !LIVE_CHECKOUT_TIERS.some((x) => x.id === t)) {
      setSearchParams({ tier: DEFAULT_TIER }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state when URL changes (back/forward nav, manual edits)
  useEffect(() => {
    const t = searchParams.get("tier");
    if (t && LIVE_CHECKOUT_TIERS.some((x) => x.id === t) && t !== selectedTier) {
      setSelectedTier(t);
    }
  }, [searchParams, selectedTier]);

  const handleSelectTier = (id: string) => {
    track('checkout_tier_select', { from: selectedTier, to: id });
    setSelectedTier(id);
    setSearchParams({ tier: id }, { replace: true });
  };

  const handlePurchase = async () => {
    if (!disclaimerAccepted || !tier.isLive) return;
    track('checkout_click_pay', { tier: selectedTier });
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { tierId: selectedTier, disclaimerAccepted: true },
      });
      if (error) throw error;
      if (data?.url) {
        track('checkout_session_created', { tier: selectedTier });
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      const code = err instanceof Error ? err.message.slice(0, 80) : 'unknown';
      track('checkout_session_failed', { tier: selectedTier, error_code: code });
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
            onAcceptedChange={(v) => { setDisclaimerAccepted(v); track('checkout_disclaimer_toggle', { accepted: v }); }}
          />

          {/* Pay button */}
          <Button
            className="w-full h-12 text-base font-semibold"
            size="lg"
            disabled={!disclaimerAccepted || isProcessing || !tier.isLive}
            onClick={handlePurchase}
          >
            {!tier.isLive ? (
              "Coming Soon"
            ) : isProcessing ? (
              "Processing…"
            ) : (
              <>
                Pay ${tier.price.toLocaleString()} — Start Evaluation
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            Secure payment processed by Stripe. Refund eligibility is subject to
            our <Link to="/rules#refunds" className="underline hover:text-foreground">refund policy</Link>.
          </p>
        </section>
      </main>
    </div>
  );
}
