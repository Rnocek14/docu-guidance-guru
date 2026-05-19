import { useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ArrowRight, Loader2 } from "lucide-react";
import { format } from "date-fns";

type PublicShare = {
  short_id: string;
  display_name: string;
  amount: number;
  paid_at: string | null;
};

export default function PublicPayoutShare() {
  const { shortId } = useParams<{ shortId: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["public-payout-share", shortId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_public_payout_share", {
        _short_id: shortId,
      });
      if (error) throw error;
      return (data as PublicShare[])?.[0] ?? null;
    },
    enabled: !!shortId,
  });

  useEffect(() => {
    if (data) {
      const title = `${data.display_name} got paid $${Number(data.amount).toLocaleString()} — Meridian`;
      document.title = title;
      const desc = `Verified payout of $${Number(data.amount).toLocaleString()} from a Meridian simulated trading account.`;
      const meta = document.querySelector('meta[name="description"]') ?? Object.assign(document.createElement('meta'), { name: 'description' });
      meta.setAttribute('content', desc);
      if (!meta.parentNode) document.head.appendChild(meta);
    }
  }, [data]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold text-foreground">Payout not found</h1>
        <p className="text-muted-foreground max-w-sm">
          This payout link is no longer public or never existed.
        </p>
        <Button asChild>
          <Link to="/">Visit Meridian</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex flex-col items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md border-primary/20 shadow-2xl">
        <CardContent className="p-8 space-y-6 text-center">
          <div className="flex items-center justify-center gap-2 text-primary">
            <CheckCircle2 className="h-5 w-5" />
            <span className="text-sm font-medium uppercase tracking-wide">Verified Payout</span>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{data.display_name} just got paid</p>
            <p className="text-6xl font-bold tabular-nums text-foreground">
              ${Number(data.amount).toLocaleString()}
            </p>
          </div>

          {data.paid_at && (
            <div className="flex items-center justify-center">
              <span className="text-xs text-muted-foreground">
                {format(new Date(data.paid_at), 'MMM d, yyyy')}
              </span>
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-3">
            <p className="text-xs text-muted-foreground">
              Paid by <span className="font-semibold text-foreground">Meridian</span> — a simulated
              trading evaluation platform.
            </p>
            <Button asChild className="w-full gap-2">
              <Link to="/checkout">
                Start your own evaluation
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Link to="/payouts" className="mt-6 text-sm text-muted-foreground hover:text-foreground">
        See more verified payouts →
      </Link>
    </div>
  );
}