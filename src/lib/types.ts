// Core type definitions for the Risk Analytics Platform

export type AppRole = 'trader' | 'risk_officer' | 'support' | 'admin';

export type AccountStatus = 
  | 'active'
  | 'breached_detected'
  | 'under_review'
  | 'failed_confirmed'
  | 'passed'
  | 'payout_requested'
  | 'payout_under_review'
  | 'payout_approved'
  | 'closed';

export type PayoutStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'paid';

export type FlagStatus = 'pending' | 'cleared' | 'escalated' | 'resolved';

export type AuditAction =
  | 'account_created'
  | 'status_changed'
  | 'breach_detected'
  | 'flag_created'
  | 'flag_cleared'
  | 'flag_escalated'
  | 'payout_requested'
  | 'payout_approved'
  | 'payout_rejected'
  | 'failure_confirmed'
  | 'role_assigned'
  | 'role_revoked'
  | 'cohort_assigned'
  | 'intake_paused'
  | 'intake_resumed';

export interface Profile {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  kyc_status: string;
  kyc_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: AppRole;
  assigned_by: string | null;
  assigned_at: string;
}

export interface Cohort {
  id: string;
  name: string;
  version: number;
  description: string | null;
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
  max_position_size_percent: number;
  intake_active: boolean;
  created_at: string;
  created_by: string | null;
  is_active: boolean;
}

export interface Account {
  id: string;
  user_id: string;
  cohort_id: string;
  account_number: string;
  status: AccountStatus;
  starting_balance: number;
  current_balance: number;
  highest_balance: number;
  total_pnl: number;
  daily_pnl: number;
  trading_days_count: number;
  created_at: string;
  updated_at: string;
  passed_at: string | null;
  failed_at: string | null;
  cohort?: Cohort;
}

export interface Trade {
  id: string;
  account_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  status: 'open' | 'closed';
}

export interface Violation {
  id: string;
  account_id: string;
  rule_type: string;
  rule_threshold: number | null;
  actual_value: number | null;
  description: string;
  detected_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmation_notes: string | null;
}

export interface RiskScore {
  id: string;
  account_id: string;
  edge_score: number;
  abuse_score: number;
  payment_risk_score: number;
  edge_factors: unknown[];
  abuse_factors: unknown[];
  payment_factors: unknown[];
  calculated_at: string;
  updated_at: string;
}

export interface Flag {
  id: string;
  account_id: string;
  flag_type: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: FlagStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  escalated_to: string | null;
  escalated_at: string | null;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  account_id: string | null;
  action: AuditAction;
  details: Record<string, unknown>;
  reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface Payout {
  id: string;
  account_id: string;
  amount: number;
  status: PayoutStatus;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  paid_at: string | null;
  payment_reference: string | null;
}

export interface SystemSetting {
  id: string;
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
}
