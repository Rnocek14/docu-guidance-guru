-- =====================================================
-- P0-B: JURISDICTION GATING LAYER
-- Bulletproof at 3 layers: UI (soft), API (hard), DB (hardest)
-- =====================================================

-- 1) jurisdiction_rules: Defines what's allowed per country
-- =====================================================
CREATE TABLE public.jurisdiction_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text NOT NULL,                 -- ISO-3166 alpha-2, e.g. 'US', 'CA'
  is_allowed boolean NOT NULL DEFAULT true,

  -- Product gates
  allow_evaluation boolean NOT NULL DEFAULT true,
  allow_funded_sim boolean NOT NULL DEFAULT true,
  allow_payouts boolean NOT NULL DEFAULT true,

  -- Requirements
  require_kyc_before_payout boolean NOT NULL DEFAULT true,
  require_kyc_before_trading boolean NOT NULL DEFAULT false,
  require_market_data_attestation boolean NOT NULL DEFAULT true,

  -- Disclosures / terms selection (versioned)
  terms_version text NOT NULL DEFAULT 'v1',
  disclosure_version text NOT NULL DEFAULT 'v1',

  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(country_code)
);

CREATE INDEX idx_jurisdiction_rules_is_allowed ON public.jurisdiction_rules (is_allowed);

-- RLS for jurisdiction_rules
ALTER TABLE public.jurisdiction_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view jurisdiction rules"
  ON public.jurisdiction_rules FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can manage jurisdiction rules"
  ON public.jurisdiction_rules FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 2) geo_signals: Evidence used to decide user location
-- =====================================================
CREATE TABLE public.geo_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal_type text NOT NULL,     -- 'ip_country','billing_country','kyc_country','device_locale','self_attested'
  country_code text NOT NULL,
  confidence int NOT NULL DEFAULT 50,   -- 0-100
  source text,                   -- 'maxmind','stripe','kyc_provider'
  observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_geo_signals_user_observed ON public.geo_signals (user_id, observed_at DESC);
CREATE INDEX idx_geo_signals_type ON public.geo_signals (signal_type);

-- RLS for geo_signals
ALTER TABLE public.geo_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own geo signals"
  ON public.geo_signals FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all geo signals"
  ON public.geo_signals FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on geo_signals"
  ON public.geo_signals FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on geo_signals"
  ON public.geo_signals FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on geo_signals"
  ON public.geo_signals FOR DELETE
  USING (false);

-- 3) user_jurisdiction: Canonical resolved jurisdiction
-- =====================================================
CREATE TABLE public.user_jurisdiction (
  user_id uuid PRIMARY KEY,
  country_code text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  resolution_method text NOT NULL,  -- 'highest_confidence'|'manual_staff'|'kyc_country'
  confidence int NOT NULL DEFAULT 0,
  notes text
);

-- RLS for user_jurisdiction
ALTER TABLE public.user_jurisdiction ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own jurisdiction"
  ON public.user_jurisdiction FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all jurisdictions"
  ON public.user_jurisdiction FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on user_jurisdiction"
  ON public.user_jurisdiction FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on user_jurisdiction"
  ON public.user_jurisdiction FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on user_jurisdiction"
  ON public.user_jurisdiction FOR DELETE
  USING (false);

-- 4) Canonical resolver RPC (service_role only)
-- Priority: KYC > billing > IP > self-attested
-- =====================================================
CREATE OR REPLACE FUNCTION public.resolve_user_jurisdiction(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country text;
  v_conf int;
  v_method text;
BEGIN
  -- Pick best signal by priority (KYC > billing > IP > self-attested) and confidence
  SELECT country_code, confidence, 
    CASE prio 
      WHEN 1 THEN 'kyc_country'
      WHEN 2 THEN 'billing_country'
      WHEN 3 THEN 'ip_country'
      WHEN 4 THEN 'self_attested'
    END
  INTO v_country, v_conf, v_method
  FROM (
    SELECT country_code, confidence, 1 AS prio
    FROM geo_signals WHERE user_id = _user_id AND signal_type = 'kyc_country'
    UNION ALL
    SELECT country_code, confidence, 2
    FROM geo_signals WHERE user_id = _user_id AND signal_type = 'billing_country'
    UNION ALL
    SELECT country_code, confidence, 3
    FROM geo_signals WHERE user_id = _user_id AND signal_type = 'ip_country'
    UNION ALL
    SELECT country_code, confidence, 4
    FROM geo_signals WHERE user_id = _user_id AND signal_type = 'self_attested'
  ) s
  ORDER BY prio ASC, confidence DESC
  LIMIT 1;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_geo_signals');
  END IF;

  INSERT INTO user_jurisdiction(user_id, country_code, resolution_method, confidence)
  VALUES (_user_id, v_country, v_method, v_conf)
  ON CONFLICT (user_id) DO UPDATE
    SET country_code = EXCLUDED.country_code,
        resolved_at = now(),
        resolution_method = EXCLUDED.resolution_method,
        confidence = EXCLUDED.confidence;

  RETURN jsonb_build_object('success', true, 'country_code', v_country, 'confidence', v_conf, 'method', v_method);
END;
$$;

-- Lock down: service_role only
REVOKE EXECUTE ON FUNCTION public.resolve_user_jurisdiction(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_user_jurisdiction(uuid) TO service_role;

-- 5) Enforcement RPC: assert_jurisdiction_allowed
-- Called from every critical workflow
-- =====================================================
CREATE OR REPLACE FUNCTION public.assert_jurisdiction_allowed(
  p_action text  -- 'trade'|'purchase'|'payout_request'|'payout_send'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_country text;
  v_rule public.jurisdiction_rules%rowtype;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_authenticated');
  END IF;

  SELECT country_code INTO v_country
  FROM public.user_jurisdiction
  WHERE user_id = v_user;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'jurisdiction_unknown');
  END IF;

  SELECT * INTO v_rule
  FROM public.jurisdiction_rules
  WHERE country_code = v_country;

  IF NOT FOUND THEN
    -- No rules = not explicitly allowed = blocked by default
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_rules_for_country', 'country', v_country);
  END IF;

  IF v_rule.is_allowed = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'country_blocked', 'country', v_country);
  END IF;

  -- Action-specific gates
  IF p_action = 'trade' AND v_rule.allow_evaluation = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'trading_not_allowed', 'country', v_country);
  END IF;

  IF p_action = 'purchase' AND v_rule.allow_evaluation = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'purchases_not_allowed', 'country', v_country);
  END IF;

  IF p_action IN ('payout_request', 'payout_send') AND v_rule.allow_payouts = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'payouts_not_allowed', 'country', v_country);
  END IF;

  -- Check KYC requirement before trading if configured
  IF p_action = 'trade' AND v_rule.require_kyc_before_trading THEN
    DECLARE
      v_kyc_status text;
    BEGIN
      SELECT kyc_status INTO v_kyc_status FROM profiles WHERE user_id = v_user;
      IF v_kyc_status IS DISTINCT FROM 'verified' THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'kyc_required_before_trading', 'country', v_country);
      END IF;
    END;
  END IF;

  -- Check KYC requirement before payout if configured
  IF p_action IN ('payout_request', 'payout_send') AND v_rule.require_kyc_before_payout THEN
    DECLARE
      v_kyc_status text;
    BEGIN
      SELECT kyc_status INTO v_kyc_status FROM profiles WHERE user_id = v_user;
      IF v_kyc_status IS DISTINCT FROM 'verified' THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'kyc_required_before_payout', 'country', v_country);
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'country', v_country,
    'terms_version', v_rule.terms_version,
    'disclosure_version', v_rule.disclosure_version,
    'require_market_data_attestation', v_rule.require_market_data_attestation
  );
END;
$$;

-- Lock down: authenticated users can check their own jurisdiction
REVOKE EXECUTE ON FUNCTION public.assert_jurisdiction_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_jurisdiction_allowed(text) TO authenticated;

-- 6) VPN / mismatch detection RPC
-- Flags when IP country differs from KYC/billing
-- =====================================================
CREATE OR REPLACE FUNCTION public.check_geo_mismatch(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip_country text;
  v_kyc_country text;
  v_billing_country text;
  v_mismatch boolean := false;
  v_reasons text[] := '{}';
BEGIN
  -- Get latest signals
  SELECT country_code INTO v_ip_country
  FROM geo_signals 
  WHERE user_id = _user_id AND signal_type = 'ip_country'
  ORDER BY observed_at DESC LIMIT 1;

  SELECT country_code INTO v_kyc_country
  FROM geo_signals 
  WHERE user_id = _user_id AND signal_type = 'kyc_country'
  ORDER BY observed_at DESC LIMIT 1;

  SELECT country_code INTO v_billing_country
  FROM geo_signals 
  WHERE user_id = _user_id AND signal_type = 'billing_country'
  ORDER BY observed_at DESC LIMIT 1;

  -- Check mismatches
  IF v_ip_country IS NOT NULL AND v_kyc_country IS NOT NULL AND v_ip_country <> v_kyc_country THEN
    v_mismatch := true;
    v_reasons := array_append(v_reasons, 'ip_kyc_mismatch');
  END IF;

  IF v_ip_country IS NOT NULL AND v_billing_country IS NOT NULL AND v_ip_country <> v_billing_country THEN
    v_mismatch := true;
    v_reasons := array_append(v_reasons, 'ip_billing_mismatch');
  END IF;

  IF v_kyc_country IS NOT NULL AND v_billing_country IS NOT NULL AND v_kyc_country <> v_billing_country THEN
    v_mismatch := true;
    v_reasons := array_append(v_reasons, 'kyc_billing_mismatch');
  END IF;

  RETURN jsonb_build_object(
    'has_mismatch', v_mismatch,
    'reasons', to_jsonb(v_reasons),
    'ip_country', v_ip_country,
    'kyc_country', v_kyc_country,
    'billing_country', v_billing_country
  );
END;
$$;

-- Lock down: service_role only (called during payout review)
REVOKE EXECUTE ON FUNCTION public.check_geo_mismatch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_geo_mismatch(uuid) TO service_role;

-- 7) Insert geo signal RPC (service_role only)
-- Used by edge functions / webhooks to record signals
-- =====================================================
CREATE OR REPLACE FUNCTION public.record_geo_signal(
  _user_id uuid,
  _signal_type text,
  _country_code text,
  _confidence int DEFAULT 50,
  _source text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO geo_signals (user_id, signal_type, country_code, confidence, source, metadata)
  VALUES (_user_id, _signal_type, _country_code, _confidence, _source, _metadata);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Lock down: service_role only
REVOKE EXECUTE ON FUNCTION public.record_geo_signal(uuid, text, text, int, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_geo_signal(uuid, text, text, int, text, jsonb) TO service_role;

-- 8) Seed conservative jurisdiction rules
-- =====================================================
INSERT INTO public.jurisdiction_rules (country_code, is_allowed, allow_evaluation, allow_funded_sim, allow_payouts, require_kyc_before_payout, require_kyc_before_trading, require_market_data_attestation, terms_version, disclosure_version, reason)
VALUES
  -- Allowed countries (Tier 1)
  ('US', true, true, true, true, true, false, true, 'us_v1', 'us_v1', NULL),
  ('CA', true, true, true, true, true, false, true, 'ca_v1', 'ca_v1', NULL),
  ('GB', true, true, true, true, true, false, true, 'gb_v1', 'gb_v1', NULL),
  ('AU', true, true, true, true, true, false, true, 'au_v1', 'au_v1', NULL),
  ('DE', true, true, true, true, true, false, true, 'eu_v1', 'eu_v1', NULL),
  ('FR', true, true, true, true, true, false, true, 'eu_v1', 'eu_v1', NULL),
  ('NL', true, true, true, true, true, false, true, 'eu_v1', 'eu_v1', NULL),
  ('IE', true, true, true, true, true, false, true, 'eu_v1', 'eu_v1', NULL),
  ('CH', true, true, true, true, true, false, true, 'ch_v1', 'ch_v1', NULL),
  ('SG', true, true, true, true, true, false, true, 'sg_v1', 'sg_v1', NULL),
  ('JP', true, true, true, true, true, false, true, 'jp_v1', 'jp_v1', NULL),
  ('NZ', true, true, true, true, true, false, true, 'nz_v1', 'nz_v1', NULL),
  
  -- Blocked countries (sanctions / high risk)
  ('RU', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('BY', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('KP', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('IR', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('SY', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('CU', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions'),
  ('VE', false, false, false, false, false, false, false, 'blocked', 'blocked', 'high_risk'),
  ('MM', false, false, false, false, false, false, false, 'blocked', 'blocked', 'sanctions');

-- 9) Add audit action for jurisdiction events
-- =====================================================
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'jurisdiction_resolved';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'jurisdiction_blocked';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'geo_mismatch_detected';