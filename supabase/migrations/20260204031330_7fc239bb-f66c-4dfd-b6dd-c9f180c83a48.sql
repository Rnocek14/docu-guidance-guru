-- Add request_id column to payouts for idempotency
ALTER TABLE public.payouts
ADD COLUMN IF NOT EXISTS request_id uuid NULL;

-- Create idempotency index for payout requests
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_account_request
ON public.payouts (account_id, request_id)
WHERE request_id IS NOT NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_payouts_request_id
ON public.payouts (request_id)
WHERE request_id IS NOT NULL;