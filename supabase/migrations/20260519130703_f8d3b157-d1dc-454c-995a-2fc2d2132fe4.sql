
CREATE TABLE IF NOT EXISTS public.reset_purchases (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  bundle_id TEXT NOT NULL CHECK (bundle_id IN ('single','urgency_single','three_pack')),
  resets_total INTEGER NOT NULL CHECK (resets_total > 0),
  resets_remaining INTEGER NOT NULL CHECK (resets_remaining >= 0),
  amount_paid_cents INTEGER NOT NULL CHECK (amount_paid_cents >= 0),
  urgency_window_active BOOLEAN NOT NULL DEFAULT false,
  provider TEXT,
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','consumed','refunded','failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_purchases_user ON public.reset_purchases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reset_purchases_account ON public.reset_purchases(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_purchases_session ON public.reset_purchases(provider_session_id) WHERE provider_session_id IS NOT NULL;

ALTER TABLE public.reset_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Traders view own reset purchases"
  ON public.reset_purchases FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins view all reset purchases"
  ON public.reset_purchases FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'risk_officer'));

CREATE TRIGGER set_reset_purchases_updated_at
  BEFORE UPDATE ON public.reset_purchases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
