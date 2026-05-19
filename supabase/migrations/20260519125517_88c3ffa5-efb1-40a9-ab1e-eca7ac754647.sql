
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.payout_shares (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payout_id UUID NOT NULL REFERENCES public.payouts(id) ON DELETE CASCADE UNIQUE,
  short_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_public BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payout_shares_short_id ON public.payout_shares(short_id) WHERE is_public = true;
CREATE INDEX idx_payout_shares_payout_id ON public.payout_shares(payout_id);

ALTER TABLE public.payout_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Traders view own payout shares" ON public.payout_shares FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.payouts p JOIN public.accounts a ON a.id=p.account_id WHERE p.id=payout_shares.payout_id AND a.user_id=auth.uid()));

CREATE POLICY "Traders create own payout shares" ON public.payout_shares FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.payouts p JOIN public.accounts a ON a.id=p.account_id WHERE p.id=payout_shares.payout_id AND a.user_id=auth.uid() AND p.status IN ('paid','paid_confirmed')));

CREATE POLICY "Traders update own payout shares" ON public.payout_shares FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.payouts p JOIN public.accounts a ON a.id=p.account_id WHERE p.id=payout_shares.payout_id AND a.user_id=auth.uid()));

CREATE POLICY "Admin views all payout shares" ON public.payout_shares FOR SELECT TO authenticated
USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'risk_officer'));

CREATE TABLE public.payout_share_bonuses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payout_id UUID NOT NULL REFERENCES public.payouts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  post_url TEXT NOT NULL,
  bonus_amount NUMERIC NOT NULL DEFAULT 25,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  applied_to_payout_id UUID REFERENCES public.payouts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payout_id, post_url)
);

CREATE INDEX idx_share_bonuses_user ON public.payout_share_bonuses(user_id);
CREATE INDEX idx_share_bonuses_status ON public.payout_share_bonuses(status);

ALTER TABLE public.payout_share_bonuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Traders view own share bonuses" ON public.payout_share_bonuses FOR SELECT TO authenticated USING (user_id=auth.uid());

CREATE POLICY "Traders create own share bonuses" ON public.payout_share_bonuses FOR INSERT TO authenticated
WITH CHECK (user_id=auth.uid() AND EXISTS (SELECT 1 FROM public.payouts p JOIN public.accounts a ON a.id=p.account_id WHERE p.id=payout_share_bonuses.payout_id AND a.user_id=auth.uid() AND p.status IN ('paid','paid_confirmed')));

CREATE POLICY "Admin views all share bonuses" ON public.payout_share_bonuses FOR SELECT TO authenticated
USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'risk_officer'));

CREATE POLICY "Admin updates share bonuses" ON public.payout_share_bonuses FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'risk_officer'));

CREATE OR REPLACE FUNCTION public.get_public_payout_share(_short_id TEXT)
RETURNS TABLE (short_id TEXT, display_name TEXT, amount NUMERIC, tier_name TEXT, paid_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT ps.short_id, COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'), p.amount, c.name, p.paid_at
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id=ps.payout_id
  JOIN public.accounts a ON a.id=p.account_id
  JOIN public.cohorts c ON c.id=a.cohort_id
  WHERE ps.short_id=_short_id AND ps.is_public=true AND p.status IN ('paid','paid_confirmed')
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_payout_share(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_recent_public_payouts(_limit INT DEFAULT 20)
RETURNS TABLE (short_id TEXT, display_name TEXT, amount NUMERIC, tier_name TEXT, paid_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT ps.short_id, COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'), p.amount, c.name, p.paid_at
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id=ps.payout_id
  JOIN public.accounts a ON a.id=p.account_id
  JOIN public.cohorts c ON c.id=a.cohort_id
  WHERE ps.is_public=true AND p.status IN ('paid','paid_confirmed')
  ORDER BY p.paid_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(_limit,1),100);
$$;

GRANT EXECUTE ON FUNCTION public.get_recent_public_payouts(INT) TO anon, authenticated;

CREATE TRIGGER payout_shares_set_updated_at BEFORE UPDATE ON public.payout_shares
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TRIGGER payout_share_bonuses_set_updated_at BEFORE UPDATE ON public.payout_share_bonuses
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
