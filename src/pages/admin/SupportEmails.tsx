import { useState, useRef, useCallback, useEffect } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useKeyboardNavigation } from '@/hooks/use-keyboard-navigation';
import {
  Mail, Send, Tag, CheckCircle, AlertCircle, Archive,
  User, RefreshCw, Search, Zap, Clock, Brain, Shield,
  AlertTriangle, Eye,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const TAG_COLORS: Record<string, string> = {
  payout_status: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  breach_explanation: 'bg-red-500/10 text-red-500 border-red-500/20',
  account_issue: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  billing_refund: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  general_inquiry: 'bg-muted text-muted-foreground border-border',
};

const TAG_LABELS: Record<string, string> = {
  payout_status: 'Payout Status',
  breach_explanation: 'Breach Explanation',
  account_issue: 'Account Issue',
  billing_refund: 'Billing / Refund',
  general_inquiry: 'General Inquiry',
};

const STATUS_CONFIG: Record<string, { icon: typeof Mail; label: string }> = {
  new: { icon: Mail, label: 'New' },
  needs_human: { icon: AlertTriangle, label: 'Needs Human' },
  review_suggested: { icon: Eye, label: 'Review' },
  ready: { icon: CheckCircle, label: 'Ready' },
  sent: { icon: Send, label: 'Sent' },
  failed: { icon: AlertCircle, label: 'Failed' },
  archived: { icon: Archive, label: 'Archived' },
};

const QUICK_FILTERS = [
  { key: 'needs_human', label: 'Needs Human', icon: AlertTriangle },
  { key: 'review_suggested', label: 'Review', icon: Eye },
  { key: 'ready', label: 'Ready', icon: CheckCircle },
  { key: 'failed', label: 'Failed', icon: AlertCircle },
] as const;

interface SupportEmail {
  id: string;
  from_address: string;
  subject: string;
  body_text: string;
  tag: string;
  confidence: number;
  ai_summary: string | null;
  draft_reply: string | null;
  status: string;
  matched_user_id: string | null;
  sent_at: string | null;
  created_at: string;
  ai_status: string;
  ai_model: string | null;
  ai_tokens_used: number | null;
  ai_latency_ms: number | null;
  auto_sendable: boolean;
  auto_send_blocked_reason: string | null;
  auto_send_ready: boolean;
  human_override: boolean;
  assigned_to: string | null;
}

export default function SupportEmails() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEmail, setSelectedEmail] = useState<SupportEmail | null>(null);
  const [editedReply, setEditedReply] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data: emails, isLoading } = useQuery({
    queryKey: ['support-emails', filterTag, filterStatus, searchQuery],
    queryFn: async () => {
      let query = supabase
        .from('support_emails')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filterTag !== 'all') query = query.eq('tag', filterTag);
      if (filterStatus !== 'all') query = query.eq('status', filterStatus);
      if (searchQuery.trim()) {
        query = query.or(`subject.ilike.%${searchQuery}%,from_address.ilike.%${searchQuery}%,body_text.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as SupportEmail[];
    },
  });

  const { data: aiCostToday } = useQuery({
    queryKey: ['ai-cost-today'],
    queryFn: async () => {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { data } = await supabase
        .from('ai_usage_log')
        .select('total_tokens, estimated_cost_cents')
        .gte('created_at', todayStart.toISOString());
      if (!data) return { tokens: 0, cost: 0 };
      return {
        tokens: data.reduce((s, r) => s + (r.total_tokens || 0), 0),
        cost: data.reduce((s, r) => s + Number(r.estimated_cost_cents || 0), 0),
      };
    },
    refetchInterval: 30_000,
  });

  // Keyboard navigation
  const handleEmailSelect = useCallback((email: SupportEmail) => {
    setSelectedEmail(email);
    setEditedReply(email.draft_reply || '');
  }, []);

  const { selectedIndex, setSelectedIndex } = useKeyboardNavigation({
    items: emails || [],
    onSelect: handleEmailSelect,
    enabled: true,
    searchInputRef,
    onSearchClear: () => setSearchQuery(''),
    hasSearchText: searchQuery.length > 0,
  });

  // Sync keyboard selection to detail pane
  useEffect(() => {
    if (emails && selectedIndex >= 0 && selectedIndex < emails.length) {
      const email = emails[selectedIndex];
      if (email.id !== selectedEmail?.id) {
        setSelectedEmail(email);
        setEditedReply(email.draft_reply || '');
      }
    }
  }, [selectedIndex, emails, selectedEmail?.id]);

  // Keyboard shortcuts for actions (A=archive, R=focus reply, T=tag dropdown)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (isInInput) return;
      if (!selectedEmail) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleArchive(selectedEmail.id);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedEmail]);

  const sendReply = useMutation({
    mutationFn: async ({ emailId, replyText }: { emailId: string; replyText: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('You must be logged in to send replies. Please log in and try again.');
      }
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-support-reply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ email_id: emailId, reply_text: replyText }),
        }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to send');
      return json;
    },
    onSuccess: () => {
      toast.success('Reply sent successfully');
      queryClient.invalidateQueries({ queryKey: ['support-emails'] });
      setSelectedEmail(null);
    },
    onError: (err: Error) => toast.error(`Failed to send: ${err.message}`),
  });

  const handleSend = () => {
    if (!user) {
      toast.error('Login required to send replies');
      return;
    }
    if (!selectedEmail || !editedReply.trim()) return;
    sendReply.mutate({ emailId: selectedEmail.id, replyText: editedReply });
  };

  const handleArchive = async (emailId: string) => {
    await supabase.from('support_emails').update({ status: 'archived' }).eq('id', emailId);
    queryClient.invalidateQueries({ queryKey: ['support-emails'] });
    if (selectedEmail?.id === emailId) setSelectedEmail(null);
    toast.success('Email archived');
  };

  const handleBulkArchive = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await supabase.from('support_emails').update({ status: 'archived' }).in('id', ids);
    queryClient.invalidateQueries({ queryKey: ['support-emails'] });
    setSelectedIds(new Set());
    if (selectedEmail && ids.includes(selectedEmail.id)) setSelectedEmail(null);
    toast.success(`${ids.length} emails archived`);
  };

  const handleBulkTag = async (newTag: string) => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await supabase.from('support_emails').update({
      tag: newTag,
      human_override: true,
      overridden_by: user?.id,
      overridden_at: new Date().toISOString(),
    }).in('id', ids);
    queryClient.invalidateQueries({ queryKey: ['support-emails'] });
    setSelectedIds(new Set());
    toast.success(`${ids.length} emails re-tagged as ${TAG_LABELS[newTag]}`);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!emails) return;
    if (selectedIds.size === emails.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(emails.map(e => e.id)));
    }
  };

  const statusCounts = emails?.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) || {};

  const confidenceBadge = (c: number) => {
    if (c >= 0.85) return <Badge variant="default" className="text-xs">{Math.round(c * 100)}%</Badge>;
    if (c >= 0.60) return <Badge variant="secondary" className="text-xs bg-yellow-500/10 text-yellow-600 border-yellow-500/20">{Math.round(c * 100)}%</Badge>;
    return <Badge variant="destructive" className="text-xs">{Math.round(c * 100)}%</Badge>;
  };

  return (
    <DashboardLayout title="AI Email Triage" navItems={adminNavItems}>
      <div className="space-y-4">
        {/* Quick filter chips */}
        <div className="flex flex-wrap gap-2 items-center">
          {QUICK_FILTERS.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant={filterStatus === key ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => setFilterStatus(prev => prev === key ? 'all' : key)}
            >
              <Icon className="h-3 w-3" />
              {label}
              {(statusCounts[key] || 0) > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1 text-xs">
                  {statusCounts[key]}
                </Badge>
              )}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Brain className="h-3 w-3" />
            <span>${((aiCostToday?.cost || 0) / 100).toFixed(3)} today</span>
            <span className="text-muted-foreground/50">|</span>
            <span>{(aiCostToday?.tokens || 0).toLocaleString()} tokens</span>
          </div>
        </div>

        {/* Search + Filters + Bulk Actions */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder='Search emails... (press "/")'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={filterTag} onValueChange={setFilterTag}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {Object.entries(TAG_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {Object.keys(STATUS_CONFIG).map(s => (
                <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="ghost" size="icon" onClick={() => queryClient.invalidateQueries({ queryKey: ['support-emails'] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>

          {selectedIds.size > 0 && (
            <div className="flex gap-2 items-center border-l pl-3 ml-1">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button variant="outline" size="sm" onClick={handleBulkArchive}>
                <Archive className="h-3 w-3 mr-1" /> Archive
              </Button>
              <Select onValueChange={handleBulkTag}>
                <SelectTrigger className="w-[140px] h-8">
                  <SelectValue placeholder="Re-tag..." />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TAG_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Keyboard hints */}
        <div className="flex gap-3 text-xs text-muted-foreground/60">
          <span><kbd className="px-1 py-0.5 rounded border text-[10px]">J</kbd>/<kbd className="px-1 py-0.5 rounded border text-[10px]">K</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border text-[10px]">Enter</kbd> select</span>
          <span><kbd className="px-1 py-0.5 rounded border text-[10px]">A</kbd> archive</span>
          <span><kbd className="px-1 py-0.5 rounded border text-[10px]">/</kbd> search</span>
          <span><kbd className="px-1 py-0.5 rounded border text-[10px]">Esc</kbd> clear</span>
        </div>

        {/* Main layout: list + detail */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Email list */}
          <div className="space-y-1 max-h-[calc(100vh-420px)] overflow-y-auto">
            {emails && emails.length > 0 && (
              <div className="flex items-center gap-2 px-2 py-1">
                <Checkbox
                  checked={selectedIds.size === emails.length && emails.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-xs text-muted-foreground">Select all</span>
              </div>
            )}
            {isLoading && <p className="text-muted-foreground text-sm p-4">Loading...</p>}
            {emails?.length === 0 && !isLoading && (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  No emails found.
                </CardContent>
              </Card>
            )}
            {emails?.map((email, idx) => (
              <Card
                key={email.id}
                className={`cursor-pointer transition-colors hover:border-primary/50 ${
                  selectedEmail?.id === email.id ? 'border-primary' : ''
                } ${selectedIndex === idx ? 'ring-1 ring-primary/40' : ''}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-2">
                    <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(email.id)}
                        onCheckedChange={() => toggleSelect(email.id)}
                      />
                    </div>
                    <div className="min-w-0 flex-1" onClick={() => {
                      handleEmailSelect(email);
                      setSelectedIndex(idx);
                    }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium truncate">{email.subject || '(no subject)'}</p>
                            {email.auto_sendable && <span title="Auto-sendable"><Zap className="h-3 w-3 text-green-500 shrink-0" /></span>}
                            {email.human_override && <span title="Human override"><Shield className="h-3 w-3 text-orange-500 shrink-0" /></span>}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{email.from_address}</p>
                          {email.ai_summary && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{email.ai_summary}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant="outline" className={TAG_COLORS[email.tag] || ''}>
                            {TAG_LABELS[email.tag] || email.tag}
                          </Badge>
                          <div className="flex items-center gap-1">
                            {email.confidence > 0 && confidenceBadge(email.confidence)}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(email.created_at), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Detail pane */}
          <div>
            {selectedEmail ? (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{selectedEmail.subject}</CardTitle>
                      <CardDescription className="flex items-center gap-2 mt-1">
                        <User className="h-3 w-3" />
                        {selectedEmail.from_address}
                        {selectedEmail.matched_user_id && (
                          <Badge variant="outline" className="text-xs">Matched User</Badge>
                        )}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Badge variant="outline" className={TAG_COLORS[selectedEmail.tag] || ''}>
                        <Tag className="h-3 w-3 mr-1" />
                        {TAG_LABELS[selectedEmail.tag]}
                      </Badge>
                      {selectedEmail.confidence > 0 && confidenceBadge(selectedEmail.confidence)}
                      {selectedEmail.auto_send_ready && (
                        <Badge variant="outline" className="text-xs bg-green-500/10 text-green-600 border-green-500/20">
                          <Zap className="h-3 w-3 mr-1" /> Auto-send ready
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* AI Telemetry bar */}
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                    <span className="flex items-center gap-1">
                      <Brain className="h-3 w-3" />
                      {selectedEmail.ai_status}
                    </span>
                    {selectedEmail.ai_model && <span>{selectedEmail.ai_model}</span>}
                    {selectedEmail.ai_tokens_used && <span>{selectedEmail.ai_tokens_used} tokens</span>}
                    {selectedEmail.ai_latency_ms && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{selectedEmail.ai_latency_ms}ms
                      </span>
                    )}
                    {selectedEmail.auto_send_blocked_reason && (
                      <span className="text-yellow-600 flex items-center gap-1">
                        <Shield className="h-3 w-3" />{selectedEmail.auto_send_blocked_reason}
                      </span>
                    )}
                    {selectedEmail.human_override && (
                      <span className="text-orange-500 flex items-center gap-1">
                        <Shield className="h-3 w-3" />overridden
                      </span>
                    )}
                  </div>

                  {selectedEmail.ai_summary && (
                    <div className="bg-muted/50 rounded-md p-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">AI Summary</p>
                      <p className="text-sm">{selectedEmail.ai_summary}</p>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Original Email</p>
                    <div className="bg-muted/30 rounded-md p-3 max-h-48 overflow-y-auto">
                      <pre className="text-sm whitespace-pre-wrap font-sans">{selectedEmail.body_text}</pre>
                    </div>
                  </div>

                  {selectedEmail.status !== 'sent' && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Draft Reply</p>
                      <Textarea
                        value={editedReply}
                        onChange={(e) => setEditedReply(e.target.value)}
                        rows={8}
                        placeholder="Write or edit the AI-drafted reply..."
                        className="text-sm"
                      />
                      <div className="flex gap-2 mt-2">
                        <Button
                          onClick={handleSend}
                          disabled={!editedReply.trim() || sendReply.isPending || !user}
                          className="gap-2"
                          title={!user ? 'Login required to send replies' : undefined}
                        >
                          <Send className="h-4 w-4" />
                          {!user ? 'Login Required' : sendReply.isPending ? 'Sending...' : 'Send Reply'}
                        </Button>
                        <Button variant="outline" onClick={() => handleArchive(selectedEmail.id)}>
                          <Archive className="h-4 w-4 mr-1" /> Archive
                        </Button>
                      </div>
                    </div>
                  )}

                  {selectedEmail.status === 'sent' && (
                    <div className="bg-primary/10 border border-primary/20 rounded-md p-3">
                      <div className="flex items-center gap-2 text-primary text-sm font-medium">
                        <CheckCircle className="h-4 w-4" />
                        Reply sent {selectedEmail.sent_at && formatDistanceToNow(new Date(selectedEmail.sent_at), { addSuffix: true })}
                      </div>
                      {selectedEmail.draft_reply && (
                        <pre className="text-sm whitespace-pre-wrap font-sans mt-2 text-muted-foreground">
                          {selectedEmail.draft_reply}
                        </pre>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-12 text-center text-muted-foreground">
                  <Mail className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Select an email to view details and send replies</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
