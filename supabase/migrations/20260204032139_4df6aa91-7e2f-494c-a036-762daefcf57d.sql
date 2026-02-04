-- Add trade_reconciliation_run to audit_action enum
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'trade_reconciliation_run';