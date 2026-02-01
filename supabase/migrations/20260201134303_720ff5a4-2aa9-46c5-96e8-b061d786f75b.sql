-- ============================================
-- Add idempotency fields to trades table
-- ============================================

-- Add platform identifiers for idempotent ingestion
ALTER TABLE public.trades 
ADD COLUMN IF NOT EXISTS platform_trade_id text,
ADD COLUMN IF NOT EXISTS platform_account_id text,
ADD COLUMN IF NOT EXISTS commission numeric DEFAULT 0;

-- Create unique constraint for idempotency (only for platform-ingested trades)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_platform_idempotency 
ON public.trades (platform_account_id, platform_trade_id) 
WHERE platform_trade_id IS NOT NULL;

-- ============================================
-- Add daily tracking fields to accounts
-- ============================================

-- Add fields for tracking daily reset boundaries
ALTER TABLE public.accounts
ADD COLUMN IF NOT EXISTS daily_pnl_start_balance numeric,
ADD COLUMN IF NOT EXISTS daily_reset_at timestamp with time zone DEFAULT now(),
ADD COLUMN IF NOT EXISTS last_trade_at timestamp with time zone;

-- ============================================
-- Create platform_accounts mapping table
-- ============================================

CREATE TABLE IF NOT EXISTS public.platform_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  platform_account_id text NOT NULL,
  platform_name text NOT NULL DEFAULT 'default',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (platform_account_id, platform_name)
);

-- Enable RLS
ALTER TABLE public.platform_accounts ENABLE ROW LEVEL SECURITY;

-- Staff can view all mappings
CREATE POLICY "Staff can view platform accounts"
ON public.platform_accounts
FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- Admins can manage mappings
CREATE POLICY "Admins can manage platform accounts"
ON public.platform_accounts
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- No client inserts (service role only)
CREATE POLICY "No client inserts on platform_accounts"
ON public.platform_accounts
FOR INSERT
TO authenticated
WITH CHECK (false);

-- ============================================
-- Add integration_unknown_account to flag_type options
-- ============================================

-- We use text for flag_type, so just document expected values:
-- integration_unknown_account, suspicious_pattern, rapid_profit, etc.