-- Per-(firm, account-size) competitor rules table.
-- Existing competitor_intel_snapshots stays as the raw scrape log; this
-- table holds the normalized rules row that the recommendation engine reads,
-- one row per (firm_id, account_size_usd).

CREATE TABLE public.competitor_firm_rules (
  firm_id text NOT NULL,
  account_size_usd integer NOT NULL,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot_id uuid REFERENCES public.competitor_intel_snapshots(id) ON DELETE SET NULL,
  source_url text,
  extraction_confidence text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (firm_id, account_size_usd)
);

CREATE INDEX idx_competitor_firm_rules_firm ON public.competitor_firm_rules(firm_id);
CREATE INDEX idx_competitor_firm_rules_size ON public.competitor_firm_rules(account_size_usd);

GRANT SELECT ON public.competitor_firm_rules TO authenticated;
GRANT ALL ON public.competitor_firm_rules TO service_role;

ALTER TABLE public.competitor_firm_rules ENABLE ROW LEVEL SECURITY;

-- Admin-only read; edge functions use service_role and bypass RLS.
CREATE POLICY "Admins can view competitor firm rules"
  ON public.competitor_firm_rules
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Profiles get a sizes_to_scrape column so each firm can declare which
-- account sizes the scraper should extract rules for. Default covers
-- Starter (50K), Pro (100K), Elite (200K).
ALTER TABLE public.competitor_intel_profiles
  ADD COLUMN IF NOT EXISTS sizes_to_scrape integer[] NOT NULL DEFAULT ARRAY[50000, 100000, 200000];

-- Per-firm overrides where the firm genuinely doesn't offer a size, based on
-- the pricing rows already known in the curated reference.
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[25000, 50000, 100000, 150000, 250000] WHERE firm_id = 'apex';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[50000, 100000, 150000] WHERE firm_id = 'topstep';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[25000, 50000, 100000, 150000, 250000] WHERE firm_id = 'bulenox';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[50000, 100000, 150000] WHERE firm_id = 'mffu';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[25000, 50000, 75000, 100000, 150000] WHERE firm_id = 'tradeify';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[25000, 50000, 100000, 150000] WHERE firm_id = 'tpt';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[25000, 50000, 100000] WHERE firm_id = 'alpha';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[50000, 100000] WHERE firm_id = 'halcyon';
UPDATE public.competitor_intel_profiles SET sizes_to_scrape = ARRAY[50000, 100000, 150000] WHERE firm_id = 'lucid';

CREATE TRIGGER trg_competitor_firm_rules_updated
  BEFORE UPDATE ON public.competitor_firm_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();