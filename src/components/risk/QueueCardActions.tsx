import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { 
  MoreHorizontal, 
  ArrowUpCircle, 
  MessageSquarePlus, 
  Flag, 
  CheckCircle, 
  XCircle,
  Loader2 
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

type ActionType = 'confirm_failure' | 'clear_breach' | 'escalate' | 'add_note' | 'close_flag';

interface ActionConfig {
  label: string;
  icon: typeof CheckCircle;
  isTerminal: boolean;
  adminOnly: boolean;
  requiresConfirm?: boolean;
}

const actionConfig: Record<ActionType, ActionConfig> = {
  escalate: {
    label: 'Escalate to Admin',
    icon: ArrowUpCircle,
    isTerminal: false,
    adminOnly: false,
  },
  add_note: {
    label: 'Add Note',
    icon: MessageSquarePlus,
    isTerminal: false,
    adminOnly: false,
  },
  close_flag: {
    label: 'Close Flag',
    icon: Flag,
    isTerminal: false,
    adminOnly: false,
  },
  clear_breach: {
    label: 'Clear Breach',
    icon: CheckCircle,
    isTerminal: false,
    adminOnly: true,
    requiresConfirm: true, // Impactful action requiring confirmation
  },
  confirm_failure: {
    label: 'Confirm Failure',
    icon: XCircle,
    isTerminal: true,
    adminOnly: true,
    requiresConfirm: true,
  },
};

interface QueueCardActionsProps {
  accountId: string;
  accountNumber: string;
  accountStatus: string;
  flagsCount: number;
  singleFlagId?: string | null;
  onActionComplete?: () => void;
}

export function QueueCardActions({
  accountId,
  accountNumber,
  accountStatus,
  flagsCount,
  singleFlagId,
  onActionComplete,
}: QueueCardActionsProps) {
  const { roles } = useAuth();
  const queryClient = useQueryClient();
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState<string | null>(null);

  const isAdmin = roles.includes('admin');
  const isRiskOfficer = roles.includes('risk_officer');

  const reviewMutation = useMutation({
    mutationFn: async ({ action, reason, notes, idempotencyKey, flagId }: { 
      action: ActionType; 
      reason: string; 
      notes?: string;
      idempotencyKey: string;
      flagId?: string;
    }) => {
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
            idempotency_key: idempotencyKey,
            ...(flagId && { flag_id: flagId }),
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
      setSelectedAction(null);
      setReason('');
      setNotes('');
      setPendingIdempotencyKey(null);
      onActionComplete?.();
    },
    onError: (error: Error) => {
      toast({
        title: 'Action failed',
        description: error.message,
        variant: 'destructive',
      });
      setSelectedAction(null);
      setReason('');
      setNotes('');
      setPendingIdempotencyKey(null);
    },
  });

  const handleActionClick = (action: ActionType, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    setSelectedAction(action);
    setPendingIdempotencyKey(crypto.randomUUID());
  };

  const handleSubmit = () => {
    if (!selectedAction || !reason.trim()) return;
    
    const config = actionConfig[selectedAction];
    // Show confirm dialog for terminal actions OR actions that require confirmation
    if (config.isTerminal || config.requiresConfirm) {
      setShowConfirmDialog(true);
    } else {
      executeAction();
    }
  };

  const executeAction = () => {
    if (!selectedAction || !reason.trim() || !pendingIdempotencyKey) return;
    reviewMutation.mutate({ 
      action: selectedAction, 
      reason: reason.trim(), 
      notes: notes.trim() || undefined,
      idempotencyKey: pendingIdempotencyKey,
      flagId: selectedAction === 'close_flag' ? (singleFlagId || undefined) : undefined,
    });
    setShowConfirmDialog(false);
  };

  const clearState = () => {
    setSelectedAction(null);
    setReason('');
    setNotes('');
    setPendingIdempotencyKey(null);
  };

  // Determine available actions based on status and role
  const availableActions: ActionType[] = [];

  if (isAdmin || isRiskOfficer) {
    availableActions.push('add_note');
  }

  // Close flag only available if we have the actual flag id
  if ((isAdmin || isRiskOfficer) && !!singleFlagId) {
    availableActions.push('close_flag');
  }

  if (accountStatus === 'breached_detected') {
    if (isRiskOfficer && !isAdmin) {
      availableActions.push('escalate');
    }
    if (isAdmin) {
      availableActions.push('clear_breach');
      availableActions.push('confirm_failure');
    }
  } else if (accountStatus === 'under_review') {
    if (isAdmin) {
      availableActions.push('clear_breach');
      availableActions.push('confirm_failure');
    }
  } else if (accountStatus === 'active') {
    if (isRiskOfficer && !isAdmin) {
      availableActions.push('escalate');
    }
  }

  if (availableActions.length === 0) {
    return null;
  }

  // Split actions: safe ones vs those requiring confirmation (admin-only / terminal)
  const safeActions = availableActions.filter(a => !actionConfig[a].adminOnly && !actionConfig[a].isTerminal);
  const adminActions = availableActions.filter(a => actionConfig[a].adminOnly);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {safeActions.map((action) => {
            const config = actionConfig[action];
            const Icon = config.icon;
            return (
              <DropdownMenuItem
                key={action}
                onClick={(e) => handleActionClick(action, e)}
              >
                <Icon className="h-4 w-4 mr-2" />
                {config.label}
              </DropdownMenuItem>
            );
          })}
          
          {adminActions.length > 0 && safeActions.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Admin Only
              </div>
            </>
          )}
          
          {adminActions.map((action) => {
            const config = actionConfig[action];
            const Icon = config.icon;
            return (
              <DropdownMenuItem
                key={action}
                onClick={(e) => handleActionClick(action, e)}
                className={config.isTerminal ? "text-destructive focus:text-destructive" : ""}
              >
                <Icon className="h-4 w-4 mr-2" />
                {config.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Reason Dialog */}
      <Dialog open={selectedAction !== null && !showConfirmDialog} onOpenChange={(open) => {
        if (!open) clearState();
      }}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>
              {selectedAction && actionConfig[selectedAction].label}
            </DialogTitle>
            <DialogDescription>
              Account #{accountNumber}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="quick-reason">Reason (required)</Label>
              <Textarea
                id="quick-reason"
                placeholder="Enter the reason for this action..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quick-notes">Notes (optional)</Label>
              <Textarea
                id="quick-notes"
                placeholder="Any additional notes..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[60px]"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={clearState}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={!reason.trim() || reviewMutation.isPending}
              variant={selectedAction === 'confirm_failure' ? 'destructive' : 'default'}
            >
              {reviewMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {selectedAction && actionConfig[selectedAction].isTerminal ? 'Continue' : 'Submit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for terminal actions */}
      <AlertDialog open={showConfirmDialog} onOpenChange={(open) => {
        setShowConfirmDialog(open);
        if (!open) clearState();
      }}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedAction === 'confirm_failure' && (
                <>
                  This will permanently mark account #{accountNumber} as <strong>failed</strong>. 
                  This action cannot be undone.
                </>
              )}
              {selectedAction === 'clear_breach' && (
                <>
                  This will clear the breach on account #{accountNumber} and restore it to <strong>active</strong> status.
                  The trader will be able to continue trading.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeAction}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
