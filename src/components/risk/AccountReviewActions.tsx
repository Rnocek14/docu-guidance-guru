import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { CheckCircle, XCircle, ArrowUpCircle, Loader2, MessageSquarePlus, Flag } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

interface AccountReviewActionsProps {
  accountId: string;
  accountNumber: string;
  accountStatus: string;
  onActionComplete?: () => void;
}

type ActionType = 'confirm_failure' | 'clear_breach' | 'escalate' | 'add_note' | 'close_flag';

interface ActionConfig {
  title: string;
  description: string;
  buttonLabel: string;
  buttonVariant: 'default' | 'destructive' | 'outline' | 'secondary';
  icon: typeof CheckCircle;
  requiresConfirm: boolean;
  isTerminal: boolean;
}

const actionConfig: Record<ActionType, ActionConfig> = {
  confirm_failure: {
    title: 'Confirm Failure',
    description: 'This will permanently mark the account as failed. This action cannot be undone.',
    buttonLabel: 'Confirm Failure',
    buttonVariant: 'destructive',
    icon: XCircle,
    requiresConfirm: true,
    isTerminal: true,
  },
  clear_breach: {
    title: 'Clear Breach',
    description: 'This will restore the account to active status and clear the detected breach.',
    buttonLabel: 'Clear Breach',
    buttonVariant: 'outline',
    icon: CheckCircle,
    requiresConfirm: true,
    isTerminal: false,
  },
  escalate: {
    title: 'Escalate to Admin',
    description: 'This will escalate the account for admin review.',
    buttonLabel: 'Escalate',
    buttonVariant: 'default',
    icon: ArrowUpCircle,
    requiresConfirm: false,
    isTerminal: false,
  },
  add_note: {
    title: 'Add Review Note',
    description: 'Add a note to the account review history.',
    buttonLabel: 'Add Note',
    buttonVariant: 'secondary',
    icon: MessageSquarePlus,
    requiresConfirm: false,
    isTerminal: false,
  },
  close_flag: {
    title: 'Close Flag',
    description: 'Mark the flag as reviewed and closed.',
    buttonLabel: 'Close Flag',
    buttonVariant: 'outline',
    icon: Flag,
    requiresConfirm: false,
    isTerminal: false,
  },
};

export function AccountReviewActions({ 
  accountId, 
  accountNumber, 
  accountStatus,
  onActionComplete 
}: AccountReviewActionsProps) {
  const { roles } = useAuth();
  const queryClient = useQueryClient();
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const isAdmin = roles.includes('admin');
  const isRiskOfficer = roles.includes('risk_officer');

  const reviewMutation = useMutation({
    mutationFn: async ({ action, reason, notes }: { action: ActionType; reason: string; notes?: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(
        `https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/review-actions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            action,
            account_id: accountId,
            reason,
            notes,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to perform action');
      }

      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: 'Action completed',
        description: data.new_status 
          ? `Account status changed to: ${data.new_status}` 
          : 'Action recorded successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      queryClient.invalidateQueries({ queryKey: ['account-details', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account-events', accountId] });
      setSelectedAction(null);
      setReason('');
      setNotes('');
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({
        title: 'Action failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleActionClick = (action: ActionType) => {
    setSelectedAction(action);
  };

  const handleSubmit = () => {
    if (!selectedAction || !reason.trim()) return;
    
    const config = actionConfig[selectedAction];
    if (config.requiresConfirm) {
      setShowConfirmDialog(true);
    } else {
      executeAction();
    }
  };

  const executeAction = () => {
    if (!selectedAction || !reason.trim()) return;
    reviewMutation.mutate({ action: selectedAction, reason: reason.trim(), notes: notes.trim() || undefined });
    setShowConfirmDialog(false);
  };

  // Determine which actions are available based on account status and user role
  const availableActions: ActionType[] = [];
  
  // Risk officers and admins can always add notes
  if (isAdmin || isRiskOfficer) {
    availableActions.push('add_note');
  }

  if (accountStatus === 'breached_detected') {
    // Risk officers: reversible actions only
    if (isRiskOfficer && !isAdmin) {
      availableActions.push('escalate');
    }
    // Admins: all actions
    if (isAdmin) {
      availableActions.push('clear_breach');
      availableActions.push('confirm_failure');
    }
  } else if (accountStatus === 'under_review') {
    // Only admins can take terminal actions on escalated accounts
    if (isAdmin) {
      availableActions.push('clear_breach');
      availableActions.push('confirm_failure');
    }
  } else if (accountStatus === 'active') {
    // Risk officers can escalate active accounts for review
    if (isRiskOfficer && !isAdmin) {
      availableActions.push('escalate');
    }
  }

  if (availableActions.length === 0) {
    return null;
  }

  // Group actions by type for better UI
  const terminalActions = availableActions.filter(a => actionConfig[a].isTerminal);
  const nonTerminalActions = availableActions.filter(a => !actionConfig[a].isTerminal);

  return (
    <>
      <div className="space-y-3">
        {/* Permission indicator */}
        <div className="flex items-center gap-2">
          <Badge variant={isAdmin ? 'default' : 'secondary'} className="text-xs">
            {isAdmin ? 'Admin View' : 'Risk Officer View'}
          </Badge>
          {isAdmin && (
            <span className="text-xs text-muted-foreground">Full action permissions</span>
          )}
        </div>

        {/* Non-terminal actions (notes, escalate, clear flag) */}
        {nonTerminalActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {nonTerminalActions.map((action) => {
              const config = actionConfig[action];
              const Icon = config.icon;
              return (
                <Button
                  key={action}
                  variant={config.buttonVariant}
                  size="sm"
                  onClick={() => handleActionClick(action)}
                  disabled={reviewMutation.isPending}
                >
                  <Icon className="h-4 w-4 mr-1" />
                  {config.buttonLabel}
                </Button>
              );
            })}
          </div>
        )}

        {/* Terminal actions (separate row, more prominent warning) */}
        {terminalActions.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground mb-2">Irreversible actions (Admin only)</p>
            <div className="flex flex-wrap gap-2">
              {terminalActions.map((action) => {
                const config = actionConfig[action];
                const Icon = config.icon;
                return (
                  <Button
                    key={action}
                    variant={config.buttonVariant}
                    size="sm"
                    onClick={() => handleActionClick(action)}
                    disabled={reviewMutation.isPending}
                  >
                    <Icon className="h-4 w-4 mr-1" />
                    {config.buttonLabel}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Reason Dialog */}
      <Dialog open={selectedAction !== null && !showConfirmDialog} onOpenChange={(open) => !open && setSelectedAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedAction && actionConfig[selectedAction].title}
            </DialogTitle>
            <DialogDescription>
              Account #{accountNumber}
              <br />
              {selectedAction && actionConfig[selectedAction].description}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="reason">Reason (required)</Label>
              <Textarea
                id="reason"
                placeholder="Enter the reason for this action..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="min-h-[100px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Additional Notes (optional)</Label>
              <Textarea
                id="notes"
                placeholder="Any additional notes..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[60px]"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedAction(null)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={!reason.trim() || reviewMutation.isPending}
              variant={selectedAction === 'confirm_failure' ? 'destructive' : 'default'}
            >
              {reviewMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for destructive actions */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedAction === 'confirm_failure' && (
                <>
                  This will permanently mark account #{accountNumber} as <strong>failed</strong>. 
                  This action cannot be undone and will be recorded in the audit log.
                </>
              )}
              {selectedAction === 'clear_breach' && (
                <>
                  This will clear the detected breach and restore account #{accountNumber} to <strong>active</strong> status.
                  This action will be recorded in the audit log.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeAction}
              className={selectedAction === 'confirm_failure' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
            >
              {reviewMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Yes, proceed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
