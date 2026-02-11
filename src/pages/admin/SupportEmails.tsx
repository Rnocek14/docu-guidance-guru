import { useState } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Mail,
  Send,
  Tag,
  Clock,
  CheckCircle,
  AlertCircle,
  Archive,
  User,
  RefreshCw,
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

const STATUS_ICONS: Record<string, typeof Mail> = {
  new: Mail,
  ready: CheckCircle,
  sent: Send,
  failed: AlertCircle,
  archived: Archive,
};

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
}

export default function SupportEmails() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedEmail, setSelectedEmail] = useState<SupportEmail | null>(null);
  const [editedReply, setEditedReply] = useState('');

  const { data: emails, isLoading } = useQuery({
    queryKey: ['support-emails', filterTag, filterStatus],
    queryFn: async () => {
      let query = supabase
        .from('support_emails')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filterTag !== 'all') query = query.eq('tag', filterTag);
      if (filterStatus !== 'all') query = query.eq('status', filterStatus);

      const { data, error } = await query;
      if (error) throw error;
      return data as SupportEmail[];
    },
  });

  const sendReply = useMutation({
    mutationFn: async ({ emailId, replyText }: { emailId: string; replyText: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-support-reply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            email_id: emailId,
            reply_text: replyText,
            user_id: user?.id,
          }),
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
    onError: (err: Error) => {
      toast.error(`Failed to send: ${err.message}`);
    },
  });

  const handleSelectEmail = (email: SupportEmail) => {
    setSelectedEmail(email);
    setEditedReply(email.draft_reply || '');
  };

  const handleSend = () => {
    if (!selectedEmail || !editedReply.trim()) return;
    sendReply.mutate({ emailId: selectedEmail.id, replyText: editedReply });
  };

  const handleArchive = async (emailId: string) => {
    await supabase.from('support_emails').update({ status: 'archived' }).eq('id', emailId);
    queryClient.invalidateQueries({ queryKey: ['support-emails'] });
    if (selectedEmail?.id === emailId) setSelectedEmail(null);
    toast.success('Email archived');
  };

  const statusCounts = emails?.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  ) || {};

  return (
    <DashboardLayout title="AI Email Triage" navItems={adminNavItems}>
      <div className="space-y-4">
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {['new', 'ready', 'sent', 'failed', 'archived'].map((s) => {
            const Icon = STATUS_ICONS[s] || Mail;
            return (
              <Card key={s} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setFilterStatus(s)}>
                <CardContent className="p-3 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-lg font-bold">{statusCounts[s] || 0}</p>
                    <p className="text-xs text-muted-foreground capitalize">{s}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex gap-3 items-center">
          <Select value={filterTag} onValueChange={setFilterTag}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {Object.entries(TAG_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="ready">Ready</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="ghost" size="icon" onClick={() => queryClient.invalidateQueries({ queryKey: ['support-emails'] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* Main layout: list + detail */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Email list */}
          <div className="space-y-2 max-h-[calc(100vh-320px)] overflow-y-auto">
            {isLoading && <p className="text-muted-foreground text-sm">Loading...</p>}
            {emails?.length === 0 && !isLoading && (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  No emails found. Set up your Resend inbound webhook to start receiving emails.
                </CardContent>
              </Card>
            )}
            {emails?.map((email) => (
              <Card
                key={email.id}
                className={`cursor-pointer transition-colors hover:border-primary/50 ${selectedEmail?.id === email.id ? 'border-primary' : ''}`}
                onClick={() => handleSelectEmail(email)}
              >
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{email.subject || '(no subject)'}</p>
                      <p className="text-xs text-muted-foreground truncate">{email.from_address}</p>
                      {email.ai_summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{email.ai_summary}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="outline" className={TAG_COLORS[email.tag] || ''}>
                        {TAG_LABELS[email.tag] || email.tag}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(email.created_at), { addSuffix: true })}
                      </span>
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
                    <div className="flex gap-1">
                      <Badge variant="outline" className={TAG_COLORS[selectedEmail.tag] || ''}>
                        <Tag className="h-3 w-3 mr-1" />
                        {TAG_LABELS[selectedEmail.tag]}
                      </Badge>
                      {selectedEmail.confidence > 0 && (
                        <Badge variant="secondary">
                          {Math.round(selectedEmail.confidence * 100)}%
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* AI Summary */}
                  {selectedEmail.ai_summary && (
                    <div className="bg-muted/50 rounded-md p-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">AI Summary</p>
                      <p className="text-sm">{selectedEmail.ai_summary}</p>
                    </div>
                  )}

                  {/* Original email */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Original Email</p>
                    <div className="bg-muted/30 rounded-md p-3 max-h-48 overflow-y-auto">
                      <pre className="text-sm whitespace-pre-wrap font-sans">{selectedEmail.body_text}</pre>
                    </div>
                  </div>

                  {/* Draft reply editor */}
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
                          disabled={!editedReply.trim() || sendReply.isPending}
                          className="gap-2"
                        >
                          <Send className="h-4 w-4" />
                          {sendReply.isPending ? 'Sending...' : 'Send Reply'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleArchive(selectedEmail.id)}
                        >
                          <Archive className="h-4 w-4 mr-1" />
                          Archive
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
