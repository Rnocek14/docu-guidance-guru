
-- ============================================================================
-- COMPETITOR INTELLIGENCE HUB — Phase 1
-- Lightweight observational system. Strictly separated from treasury logic.
-- ============================================================================

CREATE TABLE public.competitor_intel_profiles (
  firm_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  urls JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { pricing, rules, promo }
  kind TEXT NOT NULL DEFAULT 'reference',   -- 'reference' (intel only)
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.competitor_intel_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id TEXT NOT NULL REFERENCES public.competitor_intel_profiles(firm_id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version INT NOT NULL DEFAULT 1,
  scrape_kind TEXT NOT NULL DEFAULT 'weekly', -- 'weekly' | 'promo_daily'
  source_url TEXT NOT NULL,
  payload JSONB NOT NULL,                    -- normalized fields
  raw_markdown TEXT,                          -- truncated, for audit
  extraction_confidence TEXT,                 -- 'low' | 'medium' | 'high'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_intel_snapshots_firm_time ON public.competitor_intel_snapshots(firm_id, captured_at DESC);
CREATE INDEX idx_intel_snapshots_kind ON public.competitor_intel_snapshots(scrape_kind, captured_at DESC);

CREATE TABLE public.competitor_intel_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id TEXT NOT NULL REFERENCES public.competitor_intel_profiles(firm_id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES public.competitor_intel_snapshots(id) ON DELETE SET NULL,
  field TEXT NOT NULL,                        -- e.g. 'pricing.list', 'promo.depth_pct', 'rules.split'
  old_value JSONB,
  new_value JSONB,
  severity TEXT NOT NULL DEFAULT 'low',       -- 'low' | 'medium' | 'high'
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID
);
CREATE INDEX idx_intel_changes_firm_time ON public.competitor_intel_changes(firm_id, detected_at DESC);
CREATE INDEX idx_intel_changes_unack ON public.competitor_intel_changes(acknowledged, severity, detected_at DESC) WHERE acknowledged = false;

CREATE TABLE public.competitor_intel_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id UUID NOT NULL REFERENCES public.competitor_intel_changes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- 'threat' | 'opportunity' | 'noise'
  note TEXT,
  author UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_intel_annotations_change ON public.competitor_intel_annotations(change_id);

-- RLS — admin only (service role bypasses)
ALTER TABLE public.competitor_intel_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_intel_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_intel_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_intel_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_profiles" ON public.competitor_intel_profiles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admin_all_snapshots" ON public.competitor_intel_snapshots
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admin_all_changes" ON public.competitor_intel_changes
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "admin_all_annotations" ON public.competitor_intel_annotations
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed initial profiles
INSERT INTO public.competitor_intel_profiles (firm_id, name, urls, notes) VALUES
  ('apex',        'Apex Trader Funding', '{"pricing":"https://apextraderfunding.com/pricing","rules":"https://apextraderfunding.com/rules"}'::jsonb, 'High-volume futures eval; aggressive promos.'),
  ('topstep',     'Topstep',              '{"pricing":"https://www.topstep.com/pricing"}'::jsonb, 'Subscription model.'),
  ('mffu',        'MyFundedFutures',      '{"pricing":"https://myfundedfutures.com"}'::jsonb, 'Frequent flash promos.'),
  ('tpt',         'TakeProfit Trader',    '{"pricing":"https://takeprofittrader.com"}'::jsonb, '$1.5k first-payout cap visible.'),
  ('tradeify',    'Tradeify',             '{"pricing":"https://tradeify.co"}'::jsonb, 'Static DD product line.'),
  ('fundednext',  'FundedNext Futures',   '{"pricing":"https://fundednext.com"}'::jsonb, 'Newer entrant; terms shift often.'),
  ('bulenox',     'Bulenox',              '{"pricing":"https://bulenox.com"}'::jsonb, 'Heavy promo cycles.'),
  ('ftmo',        'FTMO',                 '{"pricing":"https://ftmo.com/en/pricing/"}'::jsonb, 'Refund model, 2-step.');
