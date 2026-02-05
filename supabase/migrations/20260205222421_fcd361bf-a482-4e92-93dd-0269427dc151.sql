-- P0-A: Payment Routing Layer + Chargeback First-Class Events
-- Ensures: multi-processor survivability, chargeback risk signals, KYC name match enforcement

-- =============================================================================
-- 1. PAYMENT RAILS - Processor routing configuration
-- =============================================================================
CREATE TABLE public.payment_rails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail_key text NOT NULL UNIQUE,                      -- e.g. 'stripe_cards', 'wise_payouts'
  provider text NOT NULL,                             -- 'stripe' | 'adyen' | 'nmi' | 'wise' | 'bank'
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),

  -- Capabilities
  supports_inbound boolean NOT NULL DEFAULT true,      -- can accept fees
  supports_outbound boolean NOT NULL DEFAULT false,    -- can send payouts
  methods text[] NOT NULL DEFAULT '{}',                -- ['card','ach','wire']
  currencies text[] NOT NULL DEFAULT '{USD}',

  -- Geo + risk gating
  allowed_countries text[] NOT NULL DEFAULT '{}',      -- empty = all allowed unless blocked
  blocked_countries text[] NOT NULL DEFAULT '{}',
  allowed_risk_tiers int[] NOT NULL DEFAULT '{0,1,2}', -- 0=low 1=med 2=high 3=blocked
  max_single_inbound numeric,
  max_single_outbound numeric,

  -- Routing & ops
  priority int NOT NULL DEFAULT 100,                   -- lower = preferred
  is_enabled boolean NOT NULL DEFAULT true,
  reason_disabled text,

  -- Config refs (NOT secrets - store refs only)
  config jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_rails_enabled_priority ON public.payment_rails (is_enabled, priority);
CREATE INDEX idx_payment_rails_methods ON public.payment_rails USING gin (methods);
CREATE INDEX idx_payment_rails_countries ON public.payment_rails USING gin (allowed_countries);

-- =============================================================================
-- 2. PAYMENT TRANSACTIONS - Internal ledger (source of truth)
-- =============================================================================
CREATE TABLE public.payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  purpose text NOT NULL,                              -- 'challenge_fee'|'reset_fee'|'payout'
  rail_key text REFERENCES public.payment_rails(rail_key),

  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'USD',

  status text NOT NULL DEFAULT 'created',             -- 'created'|'pending'|'succeeded'|'failed'|'reversed'
  provider text NOT NULL,
  provider_payment_id text,
  idempotency_key text NOT NULL,

  user_country text,
  user_risk_tier int NOT NULL DEFAULT 0,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(provider, idempotency_key)
);

CREATE INDEX idx_payment_transactions_user ON public.payment_transactions (user_id, created_at DESC);
CREATE INDEX idx_payment_transactions_rail ON public.payment_transactions (rail_key, created_at DESC);
CREATE INDEX idx_payment_transactions_status ON public.payment_transactions (status, created_at DESC);

-- =============================================================================
-- 3. CHARGEBACK EVENTS - First-class risk signals (P0-C bundled)
-- =============================================================================
CREATE TABLE public.chargeback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payment_txn_id uuid REFERENCES public.payment_transactions(id),

  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_dispute_id text,
  stage text NOT NULL,                                -- 'dispute_opened'|'won'|'lost'|'warning'
  reason_code text,
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  occurred_at timestamptz NOT NULL,

  -- Linkage signals for fraud detection
  card_fingerprint text,
  payment_method_fingerprint text,
  ip inet,
  country text,

  -- Downstream effects
  auto_freeze_applied boolean NOT NULL DEFAULT false,
  freeze_action_id uuid,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(provider, provider_event_id)
);

CREATE INDEX idx_chargeback_events_user ON public.chargeback_events (user_id, occurred_at DESC);
CREATE INDEX idx_chargeback_events_provider ON public.chargeback_events (provider, provider_dispute_id);
CREATE INDEX idx_chargeback_events_stage ON public.chargeback_events (stage, occurred_at DESC);

-- =============================================================================
-- 4. USER PAYMENT STATUS - Freeze flags + chargeback metrics
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payouts_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payouts_frozen_reason text,
  ADD COLUMN IF NOT EXISTS payouts_frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS card_payments_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chargeback_count_lifetime int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chargeback_count_90d int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_chargeback_at timestamptz;

-- =============================================================================
-- 5. PAYOUTS TABLE - Add routing fields
-- =============================================================================
ALTER TABLE public.payouts
  ADD COLUMN IF NOT EXISTS selected_rail_key text REFERENCES public.payment_rails(rail_key),
  ADD COLUMN IF NOT EXISTS routing_decision jsonb,
  ADD COLUMN IF NOT EXISTS kyc_name_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS destination_name_match boolean;

-- =============================================================================
-- 6. NAME NORMALIZATION FUNCTION
-- =============================================================================
CREATE OR REPLACE FUNCTION public.normalize_legal_name(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT trim(regexp_replace(upper(coalesce(input, '')), '[^A-Z ]', '', 'g'));
$$;

-- =============================================================================
-- 7. PAYMENT RAIL SELECTION RPC
-- =============================================================================
CREATE OR REPLACE FUNCTION public.select_payment_rail(
  p_direction text,
  p_method text,
  p_country text,
  p_risk_tier int,
  p_amount numeric,
  p_currency text DEFAULT 'USD'
)
RETURNS TABLE(
  rail_key text,
  provider text,
  priority int,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pr.rail_key,
    pr.provider,
    pr.priority,
    'matched'::text as reason
  FROM public.payment_rails pr
  WHERE pr.is_enabled = true
    AND (
      (p_direction = 'inbound' AND pr.supports_inbound = true) OR
      (p_direction = 'outbound' AND pr.supports_outbound = true)
    )
    AND (pr.methods @> array[p_method])
    AND (pr.currencies @> array[coalesce(p_currency, 'USD')])
    AND (
      cardinality(pr.allowed_countries) = 0 OR
      pr.allowed_countries @> array[p_country]
    )
    AND NOT (pr.blocked_countries @> array[p_country])
    AND (pr.allowed_risk_tiers @> array[p_risk_tier])
    AND (pr.max_single_inbound IS NULL OR p_direction <> 'inbound' OR p_amount <= pr.max_single_inbound)
    AND (pr.max_single_outbound IS NULL OR p_direction <> 'outbound' OR p_amount <= pr.max_single_outbound)
  ORDER BY pr.priority ASC
  LIMIT 5;  -- Return top 5 candidates for transparency
END;
$$;

-- =============================================================================
-- 8. KYC NAME MATCH VERIFICATION RPC
-- =============================================================================
CREATE OR REPLACE FUNCTION public.verify_payout_name_match(
  _user_id uuid,
  _destination_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _kyc_name text;
  _dest_name text;
  _profile record;
BEGIN
  -- Get profile with KYC info
  SELECT * INTO _profile
  FROM public.profiles
  WHERE user_id = _user_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'profile_not_found'
    );
  END IF;
  
  -- Check KYC verified
  IF COALESCE(_profile.kyc_status, 'pending') <> 'verified' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'kyc_not_verified',
      'kyc_status', _profile.kyc_status
    );
  END IF;
  
  -- Check payouts not frozen
  IF _profile.payouts_frozen THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'payouts_frozen',
      'frozen_reason', _profile.payouts_frozen_reason
    );
  END IF;
  
  -- Normalize names
  _kyc_name := normalize_legal_name(_profile.full_name);
  _dest_name := normalize_legal_name(_destination_name);
  
  IF _kyc_name IS NULL OR _kyc_name = '' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'kyc_name_empty'
    );
  END IF;
  
  IF _dest_name IS NULL OR _dest_name = '' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'destination_name_empty'
    );
  END IF;
  
  -- HARD RULE: Names must match (no override)
  IF _dest_name <> _kyc_name THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'name_mismatch',
      'kyc_name_normalized', _kyc_name,
      'destination_name_normalized', _dest_name,
      'hint', 'Payout destination name must exactly match your verified identity'
    );
  END IF;
  
  RETURN jsonb_build_object(
    'valid', true,
    'kyc_name_normalized', _kyc_name,
    'destination_name_normalized', _dest_name
  );
END;
$$;

-- =============================================================================
-- 9. CHARGEBACK AUTO-FREEZE HANDLER
-- =============================================================================
CREATE OR REPLACE FUNCTION public.process_chargeback_event(
  _user_id uuid,
  _provider text,
  _provider_event_id text,
  _provider_dispute_id text,
  _stage text,
  _reason_code text,
  _amount numeric,
  _currency text,
  _occurred_at timestamptz,
  _card_fingerprint text DEFAULT NULL,
  _ip inet DEFAULT NULL,
  _country text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _event_id uuid;
  _dispute_count_365d int;
  _should_freeze boolean := false;
  _should_block_cards boolean := false;
  _freeze_reason text;
  _profile record;
BEGIN
  -- Idempotent insert
  INSERT INTO public.chargeback_events (
    user_id, provider, provider_event_id, provider_dispute_id,
    stage, reason_code, amount, currency, occurred_at,
    card_fingerprint, ip, country
  ) VALUES (
    _user_id, _provider, _provider_event_id, _provider_dispute_id,
    _stage, _reason_code, _amount, _currency, _occurred_at,
    _card_fingerprint, _ip, _country
  )
  ON CONFLICT (provider, provider_event_id) DO UPDATE
  SET stage = EXCLUDED.stage, -- Update stage if re-delivered
      updated_at = now()
  RETURNING id INTO _event_id;
  
  -- Get current profile state
  SELECT * INTO _profile FROM public.profiles WHERE user_id = _user_id;
  
  -- Count disputes in last 365 days
  SELECT COUNT(*) INTO _dispute_count_365d
  FROM public.chargeback_events
  WHERE user_id = _user_id
    AND stage IN ('dispute_opened', 'lost')
    AND occurred_at >= now() - interval '365 days';
  
  -- AUTO-FREEZE RULES (conservative - protect the business)
  
  -- Rule 1: Any dispute opened → freeze payouts immediately
  IF _stage = 'dispute_opened' AND NOT COALESCE(_profile.payouts_frozen, false) THEN
    _should_freeze := true;
    _freeze_reason := 'chargeback_dispute_opened';
  END IF;
  
  -- Rule 2: Lost dispute → freeze + permanent card block
  IF _stage = 'lost' THEN
    _should_freeze := true;
    _should_block_cards := true;
    _freeze_reason := 'chargeback_lost';
  END IF;
  
  -- Rule 3: 2+ disputes in 365 days → freeze
  IF _dispute_count_365d >= 2 AND NOT COALESCE(_profile.payouts_frozen, false) THEN
    _should_freeze := true;
    _freeze_reason := 'chargeback_velocity_exceeded';
  END IF;
  
  -- Apply freeze if needed
  IF _should_freeze OR _should_block_cards THEN
    UPDATE public.profiles
    SET 
      payouts_frozen = CASE WHEN _should_freeze THEN true ELSE payouts_frozen END,
      payouts_frozen_reason = CASE WHEN _should_freeze AND NOT payouts_frozen THEN _freeze_reason ELSE payouts_frozen_reason END,
      payouts_frozen_at = CASE WHEN _should_freeze AND NOT payouts_frozen THEN now() ELSE payouts_frozen_at END,
      card_payments_blocked = CASE WHEN _should_block_cards THEN true ELSE card_payments_blocked END,
      chargeback_count_lifetime = chargeback_count_lifetime + 1,
      last_chargeback_at = _occurred_at
    WHERE user_id = _user_id;
    
    -- Mark event as having triggered freeze
    UPDATE public.chargeback_events
    SET auto_freeze_applied = true
    WHERE id = _event_id;
    
    -- Audit log
    INSERT INTO public.audit_logs (
      user_id, action, details, reason
    ) VALUES (
      _user_id,
      'payout_rejected'::audit_action, -- Reuse existing action for now
      jsonb_build_object(
        'trigger', 'chargeback_auto_freeze',
        'chargeback_event_id', _event_id,
        'stage', _stage,
        'dispute_count_365d', _dispute_count_365d,
        'freeze_applied', _should_freeze,
        'cards_blocked', _should_block_cards
      ),
      _freeze_reason
    );
  END IF;
  
  -- Update 90-day rolling count
  UPDATE public.profiles
  SET chargeback_count_90d = (
    SELECT COUNT(*) FROM public.chargeback_events
    WHERE user_id = _user_id
      AND stage IN ('dispute_opened', 'lost')
      AND occurred_at >= now() - interval '90 days'
  )
  WHERE user_id = _user_id;
  
  RETURN jsonb_build_object(
    'event_id', _event_id,
    'freeze_applied', _should_freeze,
    'cards_blocked', _should_block_cards,
    'freeze_reason', _freeze_reason,
    'dispute_count_365d', _dispute_count_365d
  );
END;
$$;

-- =============================================================================
-- 10. RLS POLICIES
-- =============================================================================

-- Payment Rails: Admin only write, staff read
ALTER TABLE public.payment_rails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage payment rails"
  ON public.payment_rails FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view payment rails"
  ON public.payment_rails FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- Payment Transactions: Service role writes, users read own
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client inserts on payment_transactions"
  ON public.payment_transactions FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on payment_transactions"
  ON public.payment_transactions FOR UPDATE
  USING (false);

CREATE POLICY "Users can view own transactions"
  ON public.payment_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all transactions"
  ON public.payment_transactions FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- Chargeback Events: Service role writes only
ALTER TABLE public.chargeback_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client inserts on chargeback_events"
  ON public.chargeback_events FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on chargeback_events"
  ON public.chargeback_events FOR UPDATE
  USING (false);

CREATE POLICY "Staff can view all chargeback events"
  ON public.chargeback_events FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

-- =============================================================================
-- 11. SEED DEFAULT RAILS (example config)
-- =============================================================================
INSERT INTO public.payment_rails (rail_key, provider, supports_inbound, supports_outbound, methods, priority, config)
VALUES 
  ('stripe_cards', 'stripe', true, false, '{card}', 10, '{"note": "Primary card processor"}'),
  ('stripe_ach', 'stripe', true, true, '{ach}', 20, '{"note": "ACH for US users"}'),
  ('bank_wire', 'bank', false, true, '{wire}', 50, '{"note": "Manual wire transfers"}'),
  ('wise_payouts', 'wise', false, true, '{ach,wire}', 30, '{"note": "International payouts"}')