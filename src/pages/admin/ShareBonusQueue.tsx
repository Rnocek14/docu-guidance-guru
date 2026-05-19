import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { missionControlNavItems } from "@/components/layout/AdminNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Check, X, ExternalLink, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type BonusRow = {
  id: string;
  payout_id: string;
  user_id: string;
  post_url: string;
  bonus_amount: number;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
};

const STATUSES = ["pending", "approved", "rejected", "paid"] as const;

export default function ShareBonusQueue() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("pending");

  const { data, isLoading } = useQuery({
    queryKey: ["share-bonus-queue", filter],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payout_share_bonuses")
        .select("id, payout_id, user_id, post_url, bonus_amount, status, created_at, reviewed_at, review_notes")
        .eq("status", filter)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as BonusRow[];
    },
  });

  const review = useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: "approved" | "rejected" | "paid"; notes?: string }) => {
      const { error } = await supabase
        .from("payout_share_bonuses")
        .update({
          status,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
          review_notes: notes ?? null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["share-bonus-queue"] });
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DashboardLayout title="Share Bonus Queue" navItems={missionControlNavItems}>
      <div className="space-y-4">
        <div className="flex gap-2">
          {STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={filter === s ? "default" : "outline"}
              onClick={() => setFilter(s)}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">$25 Share Bonus Claims — {filter}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !data?.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No {filter} claims.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Submitted</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Post URL</TableHead>
                    <TableHead className="text-right">Bonus</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(b.created_at), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b.user_id.slice(0, 8)}…</TableCell>
                      <TableCell>
                        <a
                          href={b.post_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1 text-xs"
                        >
                          {b.post_url.length > 50 ? `${b.post_url.slice(0, 50)}…` : b.post_url}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ${Number(b.bonus_amount).toFixed(0)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{b.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {b.status === "pending" && (
                          <div className="inline-flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-emerald-600"
                              onClick={() => review.mutate({ id: b.id, status: "approved" })}
                              aria-label="Approve"
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive"
                              onClick={() => review.mutate({ id: b.id, status: "rejected" })}
                              aria-label="Reject"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                        {b.status === "approved" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => review.mutate({ id: b.id, status: "paid" })}
                          >
                            Mark paid
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
      </div>
    </DashboardLayout>
  );
}