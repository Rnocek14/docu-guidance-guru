import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";
import { format } from "date-fns";

interface ReconciliationSummary {
  external_count: number;
  valid_external_count: number;
  invalid_external_count: number;
  internal_count: number;
  matched_count: number;
  missing_in_db_count: number;
  extra_in_db_count: number;
  mismatched_count: number;
  timestamp_warnings_count: number;
}

interface MismatchDetail {
  platform_trade_id: string;
  field: string;
  external_value: unknown;
  internal_value: unknown;
}

interface TimestampDelta {
  platform_trade_id: string;
  external_opened_at: string;
  internal_opened_at: string;
  delta_ms: number;
}

interface ReconciliationRun {
  id: string;
  account_id: string;
  platform_account_id: string;
  from_ts: string;
  to_ts: string;
  summary: ReconciliationSummary;
  missing_in_db: string[];
  extra_in_db: string[];
  mismatched: MismatchDetail[];
  invalid_external: string[];
  timestamp_deltas: TimestampDelta[];
  integrity_hash: string;
  created_at: string;
  created_by: string | null;
  request_id: string;
}

interface ReconciliationHistoryProps {
  accountId: string;
}

export function ReconciliationHistory({ accountId }: ReconciliationHistoryProps) {
  const [selectedRun, setSelectedRun] = useState<ReconciliationRun | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const { data: runs, isLoading } = useQuery({
    queryKey: ["reconciliation-runs", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_runs")
        .select("*")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      
      return (data || []).map((run) => ({
        ...run,
        summary: run.summary as unknown as ReconciliationSummary,
        missing_in_db: (run.missing_in_db as unknown as string[]) || [],
        extra_in_db: (run.extra_in_db as unknown as string[]) || [],
        mismatched: (run.mismatched as unknown as MismatchDetail[]) || [],
        invalid_external: (run.invalid_external as unknown as string[]) || [],
        timestamp_deltas: (run.timestamp_deltas as unknown as TimestampDelta[]) || [],
      })) as ReconciliationRun[];
    },
    enabled: !!accountId,
  });

  const copyHash = async (hash: string) => {
    await navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const getStatusBadge = (summary: ReconciliationSummary) => {
    const hasIssues = summary.missing_in_db_count > 0 || 
                      summary.extra_in_db_count > 0 || 
                      summary.mismatched_count > 0 ||
                      summary.invalid_external_count > 0;
    const hasWarnings = summary.timestamp_warnings_count > 0;

    if (hasIssues) {
      return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Issues Found</Badge>;
    }
    if (hasWarnings) {
      return <Badge variant="outline" className="gap-1"><AlertTriangle className="h-3 w-3" /> Warnings</Badge>;
    }
    return <Badge variant="outline" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Clean</Badge>;
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No reconciliation runs found for this account.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Time Range</TableHead>
                <TableHead className="text-center">Ext / Int</TableHead>
                <TableHead className="text-center">Missing</TableHead>
                <TableHead className="text-center">Extra</TableHead>
                <TableHead className="text-center">Mismatch</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Hash</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedRun(run)}>
                  <TableCell className="font-medium">
                    {format(new Date(run.created_at), "MMM d, yyyy HH:mm")}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(new Date(run.from_ts), "MMM d")} - {format(new Date(run.to_ts), "MMM d")}
                  </TableCell>
                  <TableCell className="text-center">
                    {run.summary.valid_external_count} / {run.summary.internal_count}
                  </TableCell>
                  <TableCell className="text-center">
                    <span className={run.summary.missing_in_db_count > 0 ? "text-destructive font-medium" : ""}>
                      {run.summary.missing_in_db_count}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className={run.summary.extra_in_db_count > 0 ? "text-destructive font-medium" : ""}>
                      {run.summary.extra_in_db_count}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className={run.summary.mismatched_count > 0 ? "text-destructive font-medium" : ""}>
                      {run.summary.mismatched_count}
                    </span>
                  </TableCell>
                  <TableCell>{getStatusBadge(run.summary)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 font-mono text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyHash(run.integrity_hash);
                      }}
                    >
                      {run.integrity_hash.slice(0, 8)}...
                      {copiedHash === run.integrity_hash ? (
                        <Check className="ml-1 h-3 w-3 text-primary" />
                      ) : (
                        <Copy className="ml-1 h-3 w-3" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" onClick={() => setSelectedRun(run)}>
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selectedRun} onOpenChange={() => setSelectedRun(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Reconciliation Details</DialogTitle>
          </DialogHeader>
          {selectedRun && (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-6 pr-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Platform Account:</span>{" "}
                    <span className="font-mono">{selectedRun.platform_account_id}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Request ID:</span>{" "}
                    <span className="font-mono text-xs">{selectedRun.request_id}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Time Range:</span>{" "}
                    {format(new Date(selectedRun.from_ts), "PPpp")} - {format(new Date(selectedRun.to_ts), "PPpp")}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Integrity Hash:</span>{" "}
                    <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{selectedRun.integrity_hash}</code>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-3">
                  <div className="p-3 rounded-lg bg-muted text-center">
                    <div className="text-2xl font-bold">{selectedRun.summary.matched_count}</div>
                    <div className="text-xs text-muted-foreground">Matched</div>
                  </div>
                  <div className={`p-3 rounded-lg text-center ${selectedRun.summary.missing_in_db_count > 0 ? 'bg-destructive/10 border border-destructive/20' : 'bg-muted'}`}>
                    <div className="text-2xl font-bold">{selectedRun.summary.missing_in_db_count}</div>
                    <div className="text-xs text-muted-foreground">Missing in DB</div>
                  </div>
                  <div className={`p-3 rounded-lg text-center ${selectedRun.summary.extra_in_db_count > 0 ? 'bg-destructive/10 border border-destructive/20' : 'bg-muted'}`}>
                    <div className="text-2xl font-bold">{selectedRun.summary.extra_in_db_count}</div>
                    <div className="text-xs text-muted-foreground">Extra in DB</div>
                  </div>
                  <div className={`p-3 rounded-lg text-center ${selectedRun.summary.mismatched_count > 0 ? 'bg-destructive/10 border border-destructive/20' : 'bg-muted'}`}>
                    <div className="text-2xl font-bold">{selectedRun.summary.mismatched_count}</div>
                    <div className="text-xs text-muted-foreground">Mismatched</div>
                  </div>
                </div>

                {selectedRun.invalid_external.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-destructive" />
                      Invalid External Trades ({selectedRun.invalid_external.length})
                    </h4>
                    <div className="bg-muted rounded p-2 font-mono text-xs max-h-32 overflow-auto">
                      {selectedRun.invalid_external.join(", ")}
                    </div>
                  </div>
                )}

                {selectedRun.missing_in_db.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      Missing in Database ({selectedRun.missing_in_db.length})
                    </h4>
                    <div className="bg-muted rounded p-2 font-mono text-xs max-h-32 overflow-auto">
                      {selectedRun.missing_in_db.join(", ")}
                    </div>
                  </div>
                )}

                {selectedRun.extra_in_db.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      Extra in Database ({selectedRun.extra_in_db.length})
                    </h4>
                    <div className="bg-muted rounded p-2 font-mono text-xs max-h-32 overflow-auto">
                      {selectedRun.extra_in_db.join(", ")}
                    </div>
                  </div>
                )}

                {selectedRun.mismatched.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-destructive" />
                      Field Mismatches ({selectedRun.mismatched.length})
                    </h4>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Trade ID</TableHead>
                          <TableHead>Field</TableHead>
                          <TableHead>External</TableHead>
                          <TableHead>Internal</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedRun.mismatched.slice(0, 20).map((m, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono text-xs">{m.platform_trade_id}</TableCell>
                            <TableCell>{m.field}</TableCell>
                            <TableCell className="font-mono text-xs">{String(m.external_value)}</TableCell>
                            <TableCell className="font-mono text-xs">{String(m.internal_value)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {selectedRun.mismatched.length > 20 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        ...and {selectedRun.mismatched.length - 20} more
                      </p>
                    )}
                  </div>
                )}

                {selectedRun.timestamp_deltas.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      Timestamp Warnings ({selectedRun.timestamp_deltas.length})
                    </h4>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Trade ID</TableHead>
                          <TableHead>External Time</TableHead>
                          <TableHead>Internal Time</TableHead>
                          <TableHead>Delta</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedRun.timestamp_deltas.slice(0, 10).map((t, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono text-xs">{t.platform_trade_id}</TableCell>
                            <TableCell className="text-xs">{format(new Date(t.external_opened_at), "HH:mm:ss")}</TableCell>
                            <TableCell className="text-xs">{format(new Date(t.internal_opened_at), "HH:mm:ss")}</TableCell>
                            <TableCell className="font-mono text-xs">{(t.delta_ms / 1000).toFixed(1)}s</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {selectedRun.timestamp_deltas.length > 10 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        ...and {selectedRun.timestamp_deltas.length - 10} more
                      </p>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
