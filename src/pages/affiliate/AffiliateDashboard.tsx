import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { Copy, Loader2, Shield } from "lucide-react";
import { buildReferralUrl } from "@/lib/referral";
import { toast } from "sonner";
import { format } from "date-fns";

type AffRow = {
  id: string;
  code: string;
  status: string;
  rate_initial_pct: number;
  rate_reset_pct: number;
  payout_method: string | null;
};

type AttribRow = {
  id: string;
  source: string;
  purchase_amount_cents: number;
  rate_pct: number;
  commission_cents: number;
  status: string;
  created_at: string;
  paid_at: string | null;
  paid_reference: string | null;
};

function fmt$(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AffiliateDashboard() {
  const { user } = useAuth();

  const aff = useQuery({
    queryKey: ["my-affiliate", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("affiliates")
        .select("id, code, status, rate_initial_pct, rate_reset_pct, payout_method")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as AffRow | null;
    },
  });

  const attributions = useQuery({
    queryKey: ["my-attributions", aff.data?.id],
    enabled: !!aff.data?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("affiliate_attributions")
        .select("id, source, purchase_amount_cents, rate_pct, commission_cents, status, created_at, paid_at, paid_reference")
        .eq("affiliate_id", aff.data!.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as AttribRow[];
    },
  });

  const totals = (attributions.data ?? []).reduce(
    (acc, r) => {
      if (r.status === "paid") acc.paid += r.commission_cents;
      else if (r.status !== "reversed") acc.pending += r.commission_cents;
      return acc;
    },
    { paid: 0, pending: 0 }
  );

  if (aff.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!aff.data) {
    return (
      <div className="min-h-screen bg-background flex items-start justify-center py-16 px-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>You're not an affiliate yet</CardTitle>
            <CardDescription>Apply to earn on traders you refer.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/affiliate/apply">Apply now</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const a = aff.data;
  const url = buildReferralUrl(a.code, "/");
  const copy = () => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied");
  };

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <Shield className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">Affiliate Dashboard</span>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="font-mono">{a.code}</CardTitle>
                <CardDescription>
                  Status: <Badge variant={a.status === "approved" ? "default" : "outline"} className="capitalize">{a.status}</Badge>
                </CardDescription>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>Initial: <strong className="text-foreground">{a.rate_initial_pct}%</strong></div>
                <div>Resets: <strong className="text-foreground">{a.rate_reset_pct}%</strong></div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {a.status === "approved" ? (
              <div className="flex items-center gap-2 p-3 rounded-md border border-border bg-muted/40 text-sm">
                <code className="flex-1 truncate font-mono">{url}</code>
                <Button size="sm" variant="outline" onClick={copy}>
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your application is <span className="capitalize">{a.status}</span>. You'll get your link once an admin approves it.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="rounded-md border border-border p-4">
                <div className="text-xs text-muted-foreground">Pending</div>
                <div className="text-2xl font-semibold">{fmt$(totals.pending)}</div>
              </div>
              <div className="rounded-md border border-border p-4">
                <div className="text-xs text-muted-foreground">Paid</div>
                <div className="text-2xl font-semibold">{fmt$(totals.paid)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent attributions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {attributions.isLoading ? (
              <div className="p-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !attributions.data?.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No attributions yet.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Purchase</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attributions.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(r.created_at), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="capitalize text-xs">{r.source}</TableCell>
                      <TableCell className="text-right">{fmt$(r.purchase_amount_cents)}</TableCell>
                      <TableCell className="text-right">{r.rate_pct}%</TableCell>
                      <TableCell className="text-right font-medium">{fmt$(r.commission_cents)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{r.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}