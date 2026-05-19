import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Loader2, RotateCcw, Sparkles, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import {
  RESET_BUNDLES,
  type ResetBundleId,
  isUrgencyActive,
  urgencyMsRemaining,
  formatCountdown,
} from '@/lib/reset-bundles';

const ICONS: Record<ResetBundleId, React.ComponentType<{ className?: string }>> = {
  single: RotateCcw,
  urgency_single: Sparkles,
  three_pack: TrendingUp,
};

export default function ResetCheckout() {
  const { accountId } = useParams<{ accountId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const initialBundle = (searchParams.get('bundle') as ResetBundleId) || 'single';
  const [selected, setSelected] = useState<ResetBundleId>(initialBundle);
  const [isProcessing, setIsProcessing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const { data: account, isLoading } = useQuery({
    queryKey: ['reset-account', accountId, user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('id, account_number, status, starting_balance')
        .eq('id', accountId!)
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!accountId && !!user?.id,
  });

  // Latest violation determines urgency window
  const { data: lastBreach } = useQuery({
    queryKey: ['reset-last-breach', accountId],
    queryFn: async () => {
      const { data } = await supabase
        .from('violations')
        .select('detected_at')
        .eq('account_id', accountId!)
        .order('detected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.detected_at ?? null;
    },
    enabled: !!accountId,
  });

  const urgencyActive = isUrgencyActive(lastBreach);
  const remaining = lastBreach ? urgencyMsRemaining(lastBreach) : 0;

  useEffect(() => {
    if (!urgencyActive) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [urgencyActive]);
  void now;

  // If user selected urgency but window expired, fall back to single
  useEffect(() => {
    if (selected === 'urgency_single' && !urgencyActive) {
      setSelected('single');
    }
  }, [selected, urgencyActive]);

  const bundles = Object.values(RESET_BUNDLES).filter(
    (b) => !b.urgencyOnly || urgencyActive
  );
  const bundle = RESET_BUNDLES[selected];

  const handleCheckout = async () => {
    if (!user) {
      toast.error('Please log in to continue.');
      navigate('/login');
      return;
    }
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-reset-checkout', {
        body: { accountId, bundleId: selected },
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error('Reset checkout error:', err);
      toast.error('Failed to start reset checkout. Please try again.');
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card>
          <CardContent className="pt-6">
            <p>Account not found.</p>
            <Button asChild variant="link"><Link to="/trader">Back to dashboard</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/trader/accounts/${accountId}`)} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back to Account
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <h1 className="text-lg font-semibold">Reset Account #{account.account_number}</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {urgencyActive && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 flex items-center justify-between">
            <div className="text-sm">
              <span className="font-medium text-foreground">24h Comeback window is open.</span>{' '}
              <span className="text-muted-foreground">Discount expires after the window closes.</span>
            </div>
            <Badge className="font-mono">{formatCountdown(remaining)}</Badge>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Choose a reset bundle</CardTitle>
            <CardDescription>
              Resets restore your account to ${account.starting_balance.toLocaleString()} starting balance.
              Bundle resets are banked to your trader account and stack across challenges.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              {bundles.map((b) => {
                const Icon = ICONS[b.id];
                const isSelected = selected === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setSelected(b.id)}
                    className={[
                      'relative text-left rounded-lg border p-4 transition-colors',
                      isSelected
                        ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                        : 'border-border bg-background hover:border-primary/40',
                    ].join(' ')}
                  >
                    {b.badge && (
                      <Badge className="absolute -top-2 right-3 text-[10px]">{b.badge}</Badge>
                    )}
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4 text-primary" />
                      {b.label}
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-bold">${b.priceUsd}</span>
                      {b.savingsUsd > 0 && (
                        <span className="text-xs text-muted-foreground">save ${b.savingsUsd}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{b.description}</p>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Order summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{bundle.label}</span>
              <span className="font-mono">${bundle.priceUsd}.00</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Resets included</span>
              <span className="font-mono">{bundle.resetCount}</span>
            </div>
            <Separator />
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="font-mono">${bundle.priceUsd}.00</span>
            </div>
            <Button onClick={handleCheckout} disabled={isProcessing} className="w-full" size="lg">
              {isProcessing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Starting checkout…</>
              ) : (
                <>Continue to secure checkout</>
              )}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Payment is processed by our secure card processor. Resets are applied automatically after
              payment confirmation. Bundle resets never expire.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
