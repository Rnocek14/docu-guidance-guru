import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Search, FileText, AlertTriangle, CheckCircle, XCircle, Info } from 'lucide-react';
import { useState } from 'react';
import type { Database } from '@/integrations/supabase/types';

type AuditAction = Database['public']['Enums']['audit_action'];

const actionCategories: Record<string, AuditAction[]> = {
  account: ['account_created', 'status_changed', 'cohort_assigned'],
  breach: ['breach_detected', 'rule_breach_detected', 'failure_confirmed'],
  flag: ['flag_created', 'flag_cleared', 'flag_escalated'],
  payout: [
    'payout_requested',
    'payout_approved',
    'payout_rejected',
    'payout_paid',
    'payout_freeze_auto_chargeback',
    'payout_freeze_manual',
    'payout_unfreeze_manual',
    'payout_hold_release_manual',
  ],
  breaker: ['breaker_transition'],
  payments: ['payment_system_paused', 'payment_system_resumed', 'card_block_auto_chargeback'],
  jurisdiction: ['jurisdiction_resolved', 'jurisdiction_blocked', 'geo_mismatch_detected'],
  ingest: ['ingest_blocked', 'ingest_quarantined', 'ingest_error', 'ingest_rejected'],
  role: ['role_assigned', 'role_revoked'],
  system: ['intake_paused', 'intake_resumed', 'evidence_pack_exported', 'trade_reconciliation_run', 'liability_alert_fired'],
  cohort: ['cohort_updated'],
};

export default function AuditLogs() {
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('all');

  // Fetch audit logs
  const { data: logs, isLoading } = useQuery({
    queryKey: ['audit-logs', actionFilter],
    queryFn: async () => {
      let query = supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (actionFilter !== 'all') {
        const actions = actionCategories[actionFilter];
        if (actions) {
          query = query.in('action', actions);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  const getActionIcon = (action: AuditAction) => {
    if (action.includes('approved') || action.includes('cleared') || action.includes('passed')) {
      return <CheckCircle className="h-4 w-4 text-success" />;
    }
    if (action.includes('rejected') || action.includes('failure') || action.includes('breach')) {
      return <XCircle className="h-4 w-4 text-destructive" />;
    }
    if (action.includes('escalated') || action.includes('paused')) {
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    }
    return <Info className="h-4 w-4 text-muted-foreground" />;
  };

  const getActionBadgeVariant = (action: AuditAction): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (action.includes('approved') || action.includes('cleared') || action.includes('resumed')) {
      return 'default';
    }
    if (action.includes('rejected') || action.includes('failure') || action.includes('breach')) {
      return 'destructive';
    }
    if (action.includes('escalated') || action.includes('paused')) {
      return 'secondary';
    }
    return 'outline';
  };

  const formatAction = (action: string) => {
    return action.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  const filteredLogs = logs?.filter((log) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      log.action.toLowerCase().includes(search) ||
      log.reason?.toLowerCase().includes(search) ||
      JSON.stringify(log.details).toLowerCase().includes(search)
    );
  });

  return (
    <DashboardLayout title="Audit Logs" navItems={missionControlNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Audit Trail</h2>
          <p className="text-muted-foreground">
            Complete log of all system actions for compliance and debugging.
          </p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search logs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="Filter by type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  <SelectItem value="account">Account Events</SelectItem>
                  <SelectItem value="breach">Breaches</SelectItem>
                  <SelectItem value="flag">Flags</SelectItem>
                  <SelectItem value="payout">Payouts</SelectItem>
                  <SelectItem value="breaker">Breaker</SelectItem>
                  <SelectItem value="payments">Payments</SelectItem>
                  <SelectItem value="jurisdiction">Jurisdiction / Geo</SelectItem>
                  <SelectItem value="ingest">Ingest</SelectItem>
                  <SelectItem value="role">Role Changes</SelectItem>
                  <SelectItem value="cohort">Cohort Changes</SelectItem>
                  <SelectItem value="system">System Actions</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Logs table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>
              Showing {filteredLogs?.length || 0} entries (max 200)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading logs...</div>
            ) : filteredLogs && filteredLogs.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[50px]"></TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{getActionIcon(log.action)}</TableCell>
                        <TableCell>
                          <Badge variant={getActionBadgeVariant(log.action)}>
                            {formatAction(log.action)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[300px]">
                          <div className="text-sm text-muted-foreground truncate">
                            {log.account_id && (
                              <span className="font-mono text-xs">
                                Account: {log.account_id.slice(0, 8)}...
                              </span>
                            )}
                            {log.details && Object.keys(log.details as object).length > 0 && (
                              <span className="ml-2">
                                {JSON.stringify(log.details).slice(0, 50)}
                                {JSON.stringify(log.details).length > 50 && '...'}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          <span className="text-sm text-muted-foreground truncate block">
                            {log.reason || '-'}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {new Date(log.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No audit logs found.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
