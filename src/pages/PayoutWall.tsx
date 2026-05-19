import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ArrowRight, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type PublicPayout = {
  short_id: string;
  display_name: string;
  amount: number;
  tier_name: string;
  paid_at: string | null;
};

export default function PayoutWall() {
  const { data, isLoading } = useQuery({
    queryKey: ["public-payout-wall"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_recent_public_payouts", { _limit: 50 });
      if (error) throw error;
      return (data as PublicPayout[]) ?? [];
    },
  });

  const total = (data ?? []).reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" className="font-semibold text-foreground">Meridian</Link>
          <Button asChild variant="outline" size="sm">
            <Link to="/checkout">Start an evaluation</Link>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 max-w-4xl">
        <div className="text-center space-y-3 mb-10">
          <div className="inline-flex items-center gap-2 text-primary text-sm font-medium">
            <CheckCircle2 className="h-4 w-4" />
            Verified Payouts
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">
            Real traders. Real payouts.
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Every payout below is verified on-platform. Click any one to see the receipt.
          </p>
          {!isLoading && data && data.length > 0 && (
            <p className="text-sm text-muted-foreground pt-2">
              <span className="font-semibold text-foreground">${total.toLocaleString()}</span> paid
              across <span className="font-semibold text-foreground">{data.length}</span> recent payouts
            </p>
          )}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : !data?.length ? (
          <Card className="border-dashed">
            <CardContent className="p-12 text-center space-y-4">
              <p className="text-muted-foreground">
                No public payouts yet. Be the first.
              </p>
              <Button asChild>
                <Link to="/checkout" className="gap-2">
                  Start your evaluation <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.map((p) => (
              <Link key={p.short_id} to={`/p/${p.short_id}`} className="group">
                <Card className="transition-all hover:border-primary/40 hover:shadow-lg">
                  <CardContent className="p-5 flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{p.display_name}</p>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">{p.tier_name}</Badge>
                        {p.paid_at && (
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(p.paid_at), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold tabular-nums text-foreground">
                        ${Number(p.amount).toLocaleString()}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}