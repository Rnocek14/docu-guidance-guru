
-- Make provider and provider_session_id NOT NULL with safe defaults for any remaining nulls
UPDATE public.accounts
SET provider = 'stripe'
WHERE provider IS NULL AND stripe_session_id IS NOT NULL;

UPDATE public.accounts
SET provider_session_id = stripe_session_id
WHERE provider_session_id IS NULL AND stripe_session_id IS NOT NULL;

-- For any rows still null (no stripe_session_id either), set a synthetic value
UPDATE public.accounts
SET provider = 'unknown',
    provider_session_id = 'legacy-' || id::text
WHERE provider IS NULL OR provider_session_id IS NULL;

-- Now enforce NOT NULL
ALTER TABLE public.accounts
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider_session_id SET NOT NULL;

-- Add CHECK to prevent empty strings
ALTER TABLE public.accounts
  ADD CONSTRAINT chk_provider_session_id_not_empty CHECK (provider_session_id <> ''),
  ADD CONSTRAINT chk_provider_not_empty CHECK (provider <> '');

-- Drop the partial index and replace with a full unique constraint
DROP INDEX IF EXISTS idx_accounts_provider_session;
CREATE UNIQUE INDEX idx_accounts_provider_session ON public.accounts (provider, provider_session_id);
