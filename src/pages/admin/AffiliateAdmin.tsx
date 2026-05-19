import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { missionControlNavItems } from "@/components/layout/AdminNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type Aff = {
  id: string;
  user_id: string;
  code: string;
  status: string;
  rate_initial_pct: number;
  rate_reset_pct: number;
  payout_method: string | null;
  applied_at: string;
};

type Attrib = {
  id: string;
  affiliate_id: string;
  buyer_user_id: string;
  source: string;
  purchase_amount_cents: number;
  commission_cents: number;
  status: string;
  created_at: string;
  paid_reference: string | null;
};

const APP_STATUS = ["pending", "approved", "rejected", "suspended"] as const;
const COMM_STATUS = ["pending", "approved", "paid", "reversed"] as const;

function fmt$(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AffiliateAdmin() {
  const qc = useQueryClient();
  const [appFilter, setAppFilter] = useState<(typeof APP_STATUS)[number]>("pending");
  const [commFilter, setCommFilter] = useState<(typeof COMM_STATUS)[number]>("pending");

  const apps = useQuery({
    queryKey: ["aff-apps", appFilter],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("affiliates")
        .select("id, user_id, code, status, rate_initial_pct, rate_reset_pct, payout_method, applied_at")
        .eq("status", appFilter)
        .order("applied_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as Aff[];
    },
  });

  const comms = useQuery({
    queryKey: ["aff-comms", commFilter],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("affiliate_attributions")
        .select("id, affiliate_id, buyer_user_id, source, purchase_amount_cents, commission_cents, status, created_at, paid_reference")
        .eq("status", commFilter)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as Attrib[];
    },
  });

  const reviewApp = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from("affiliates")
        .update({
          status,
          approved_at: status === "approved" ? new Date().toISOString() : null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aff-apps"] });
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markPaid = useMutation({
    mutationFn: async ({ id, ref }: { id: string; ref: string }) => {
      const { error } = await supabase.rpc("mark_affiliate_attribution_paid", {
        p_attribution_id: id,
        p_paid_reference: ref || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aff-comms"] });
      toast.success("Marked paid");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DashboardLayout title="Affiliates" navItems={missionControlNavItems}>
      <Tabs defaultValue="apps" className="space-y-4">
        <TabsList>
          <TabsTrigger value="apps">Applications</TabsTrigger>
          <TabsTrigger value="comms">Commissions</TabsTrigger>
        </TabsList>

        <TabsContent value="apps" className="space-y-4">
          <div className="flex gap-2">
            {APP_STATUS.map((s) => (
              <Button key={s} size="sm" variant={appFilter === s ? "default" : "outline"} onClick={() => setAppFilter(s)} className="capitalize">
                {s}
              </Button>
            ))}
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Applications — {appFilter}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {apps.isLoading ? (
                <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : !apps.data?.length ? (
                <div className="p-8 text-center text-sm text-muted-foreground">None.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Applied</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Payout</TableHead>
                      <TableHead>Rates</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apps.data.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="text-xs text-muted-foreground">{format(new Date(a.applied_at), "MMM d, HH:mm")}</TableCell>
                        <TableCell className="font-mono">{a.code}</TableCell>
                        <TableCell className="font-mono text-xs">{a.user_id.slice(0, 8)}…</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{a.payout_method ?? "—"}</TableCell>
                        <TableCell className="text-xs">{a.rate_initial_pct}% / {a.rate_reset_pct}%</TableCell>
                        <TableCell className="text-right">
                          {a.status === "pending" && (
                            <div className="inline-flex gap-1">
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => reviewApp.mutate({ id: a.id, status: "approved" })} aria-label="Approve">
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => reviewApp.mutate({ id: a.id, status: "rejected" })} aria-label="Reject">
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                          {a.status === "approved" && (
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => reviewApp.mutate({ id: a.id, status: "suspended" })}>
                              Suspend
                            </Button>
                          )}
                          {a.status === "suspended" && (
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => reviewApp.mutate({ id: a.id, status: "approved" })}>
                              Reinstate
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="comms" className="space-y-4">
          <div className="flex gap-2">
            {COMM_STATUS.map((s) => (
              <Button key={s} size="sm" variant={commFilter === s ? "default" : "outline"} onClick={() => setCommFilter(s)} className="capitalize">
                {s}
              </Button>
            ))}
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Commissions — {commFilter}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {comms.isLoading ? (
                <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : !comms.data?.length ? (
                <div className="p-8 text-center text-sm text-muted-foreground">None.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Affiliate</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Purchase</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comms.data.map((c) => (
                      <CommissionRow key={c.id} row={c} onMarkPaid={(ref) => markPaid.mutate({ id: c.id, ref })} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}

function CommissionRow({ row, onMarkPaid }: { row: Attrib; onMarkPaid: (ref: string) => void }) {
  const [ref, setRef] = useState("");
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground">{format(new Date(row.created_at), "MMM d, HH:mm")}</TableCell>
      <TableCell className="font-mono text-xs">{row.affiliate_id.slice(0, 8)}…</TableCell>
      <TableCell className="font-mono text-xs">{row.buyer_user_id.slice(0, 8)}…</TableCell>
      <TableCell className="capitalize text-xs">{row.source}</TableCell>
      <TableCell className="text-right">{fmt$(row.purchase_amount_cents)}</TableCell>
      <TableCell className="text-right font-medium">{fmt$(row.commission_cents)}</TableCell>
      <TableCell><Badge variant="outline" className="capitalize">{row.status}</Badge></TableCell>
      <TableCell>
        {row.status === "pending" || row.status === "approved" ? (
          <div className="flex gap-1 items-center">
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Stripe txn / ref" className="h-7 text-xs w-32" />
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onMarkPaid(ref)}>
              Mark paid
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{row.paid_reference ?? "—"}</span>
        )}
      </TableCell>
    </TableRow>
  );
}