-- =============================================
-- P0 BLOCKERS: FRAUD DETECTION & PAYOUT HARDENING
-- =============================================

-- 1. Add payout caps and cooldown settings to cohorts
ALTER TABLE public.cohorts
ADD COLUMN IF NOT EXISTS max_payout_percent numeric NOT NULL DEFAULT 80.00,
ADD COLUMN IF NOT EXISTS max_payout_absolute numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS payout_cooldown_days integer NOT NULL DEFAULT 30,
ADD COLUMN IF NOT EXISTS min_trading_days_between_payouts integer NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS payout_split_percent numeric NOT NULL DEFAULT 80.00;

COMMENT ON COLUMN public.cohorts.max_payout_percent IS 'Maximum payout as percentage of realized profits';
COMMENT ON COLUMN public.cohorts.max_payout_absolute IS 'Hard cap on single payout amount (null = no cap)';
COMMENT ON COLUMN public.cohorts.payout_cooldown_days IS 'Minimum days between payout requests';
COMMENT ON COLUMN public.cohorts.min_trading_days_between_payouts IS 'Required trading days since last payout';
COMMENT ON COLUMN public.cohorts.payout_split_percent IS 'Profit split percentage (e.g., 80 = trader gets 80%)';

-- 2. Identity clusters for linking related accounts
CREATE TABLE IF NOT EXISTS public.identity_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_name text,
  risk_score integer NOT NULL DEFAULT 0,
  is_flagged boolean NOT NULL DEFAULT false,
  flag_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.identity_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view identity clusters"
ON public.identity_clusters FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can manage identity clusters"
ON public.identity_clusters FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- 3. Device fingerprints for multi-account detection
CREATE TABLE IF NOT EXISTS public.device_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  fingerprint_hash text NOT NULL,
  fingerprint_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  asn text,
  country_code text,
  is_vpn boolean DEFAULT false,
  cluster_id uuid REFERENCES public.identity_clusters(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1,
  UNIQUE(user_id, fingerprint_hash)
);

CREATE INDEX idx_device_fingerprints_hash ON public.device_fingerprints(fingerprint_hash);
CREATE INDEX idx_device_fingerprints_cluster ON public.device_fingerprints(cluster_id);
CREATE INDEX idx_device_fingerprints_user ON public.device_fingerprints(user_id);

ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own fingerprints"
ON public.device_fingerprints FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Staff can view all fingerprints"
ON public.device_fingerprints FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on device_fingerprints"
ON public.device_fingerprints FOR INSERT
WITH CHECK (false);

CREATE POLICY "No client updates on device_fingerprints"
ON public.device_fingerprints FOR UPDATE
USING (false);

-- 4. Payout methods with dedup detection
CREATE TABLE IF NOT EXISTS public.payout_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method_type text NOT NULL CHECK (method_type IN ('bank_transfer', 'crypto', 'paypal', 'wise', 'other')),
  method_hash text NOT NULL,
  method_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  cluster_id uuid REFERENCES public.identity_clusters(id),
  is_verified boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, method_hash)
);

CREATE INDEX idx_payout_methods_hash ON public.payout_methods(method_hash);
CREATE INDEX idx_payout_methods_cluster ON public.payout_methods(cluster_id);
CREATE INDEX idx_payout_methods_user ON public.payout_methods(user_id);

ALTER TABLE public.payout_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payout methods"
ON public.payout_methods FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own payout methods"
ON public.payout_methods FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff can view all payout methods"
ON public.payout_methods FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can manage payout methods"
ON public.payout_methods FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- 5. Trade correlations for cross-account detection
CREATE TABLE IF NOT EXISTS public.trade_correlations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id_a uuid NOT NULL REFERENCES public.accounts(id),
  account_id_b uuid NOT NULL REFERENCES public.accounts(id),
  correlation_type text NOT NULL CHECK (correlation_type IN ('opposite_side', 'same_timing', 'mirror_pattern', 'cluster_link')),
  correlation_score numeric NOT NULL DEFAULT 0,
  sample_trades jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'cleared', 'confirmed_fraud', 'watching')),
  review_notes text,
  UNIQUE(account_id_a, account_id_b, correlation_type)
);

CREATE INDEX idx_trade_correlations_accounts ON public.trade_correlations(account_id_a, account_id_b);
CREATE INDEX idx_trade_correlations_status ON public.trade_correlations(review_status);

ALTER TABLE public.trade_correlations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view trade correlations"
ON public.trade_correlations FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on trade_correlations"
ON public.trade_correlations FOR INSERT
WITH CHECK (false);

CREATE POLICY "Admins can update trade correlations"
ON public.trade_correlations FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

-- 6. Fraud review queue for manual gates
CREATE TABLE IF NOT EXISTS public.fraud_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('payout', 'account', 'user', 'cluster')),
  entity_id uuid NOT NULL,
  review_type text NOT NULL CHECK (review_type IN ('payout_amount', 'velocity', 'correlation', 'device_match', 'method_reuse', 'manual')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'escalated')),
  auto_block boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_to uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  request_id uuid
);

CREATE INDEX idx_fraud_reviews_entity ON public.fraud_reviews(entity_type, entity_id);
CREATE INDEX idx_fraud_reviews_status ON public.fraud_reviews(status);
CREATE INDEX idx_fraud_reviews_severity ON public.fraud_reviews(severity);

ALTER TABLE public.fraud_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view fraud reviews"
ON public.fraud_reviews FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on fraud_reviews"
ON public.fraud_reviews FOR INSERT
WITH CHECK (false);

CREATE POLICY "Admins can manage fraud reviews"
ON public.fraud_reviews FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- 7. Add payout_method_id to payouts table
ALTER TABLE public.payouts
ADD COLUMN IF NOT EXISTS payout_method_id uuid REFERENCES public.payout_methods(id),
ADD COLUMN IF NOT EXISTS calculated_eligible_amount numeric,
ADD COLUMN IF NOT EXISTS submitted_amount numeric,
ADD COLUMN IF NOT EXISTS fraud_review_id uuid REFERENCES public.fraud_reviews(id),
ADD COLUMN IF NOT EXISTS device_fingerprint_id uuid REFERENCES public.device_fingerprints(id);

COMMENT ON COLUMN public.payouts.calculated_eligible_amount IS 'Server-calculated eligible payout amount';
COMMENT ON COLUMN public.payouts.submitted_amount IS 'Amount submitted by client (for audit comparison)';

-- 8. Helper function to check payout eligibility
CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(
  _account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _account record;
  _cohort record;
  _last_payout record;
  _pending_violations integer;
  _pending_flags integer;
  _pending_fraud_reviews integer;
  _trading_days_since_payout integer;
  _days_since_last_payout integer;
  _realized_profit numeric;
  _max_eligible numeric;
  _result jsonb;
BEGIN
  -- Get account with cohort
  SELECT a.*, c.*
  INTO _account
  FROM accounts a
  JOIN cohorts c ON a.cohort_id = c.id
  WHERE a.id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  -- Get cohort separately for clarity
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  
  -- Check account status
  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account status must be passed or in payout flow',
      'current_status', _account.status
    );
  END IF;
  
  -- Check for pending violations
  SELECT COUNT(*) INTO _pending_violations
  FROM violations
  WHERE account_id = _account_id AND confirmed_at IS NULL;
  
  IF _pending_violations > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending violations',
      'pending_violations', _pending_violations
    );
  END IF;
  
  -- Check for pending flags
  SELECT COUNT(*) INTO _pending_flags
  FROM flags
  WHERE account_id = _account_id AND status = 'pending';
  
  IF _pending_flags > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending flags',
      'pending_flags', _pending_flags
    );
  END IF;
  
  -- Check for pending fraud reviews
  SELECT COUNT(*) INTO _pending_fraud_reviews
  FROM fraud_reviews
  WHERE entity_type = 'account' AND entity_id = _account_id AND status IN ('pending', 'in_review');
  
  IF _pending_fraud_reviews > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending fraud review',
      'pending_fraud_reviews', _pending_fraud_reviews
    );
  END IF;
  
  -- Get last paid payout
  SELECT * INTO _last_payout
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid'
  ORDER BY paid_at DESC
  LIMIT 1;
  
  -- Check cooldown period
  IF _last_payout IS NOT NULL THEN
    _days_since_last_payout := EXTRACT(DAY FROM (now() - _last_payout.paid_at));
    
    IF _days_since_last_payout < _cohort.payout_cooldown_days THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Payout cooldown period not met',
        'days_since_last_payout', _days_since_last_payout,
        'required_cooldown_days', _cohort.payout_cooldown_days,
        'days_remaining', _cohort.payout_cooldown_days - _days_since_last_payout
      );
    END IF;
    
    -- Check trading days since last payout
    SELECT COUNT(DISTINCT DATE(opened_at)) INTO _trading_days_since_payout
    FROM trades
    WHERE account_id = _account_id AND opened_at > _last_payout.paid_at;
    
    IF _trading_days_since_payout < _cohort.min_trading_days_between_payouts THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Not enough trading days since last payout',
        'trading_days_since_payout', _trading_days_since_payout,
        'required_trading_days', _cohort.min_trading_days_between_payouts
      );
    END IF;
  END IF;
  
  -- Calculate realized profit (account balance - starting balance - already paid out)
  _realized_profit := _account.current_balance - _account.starting_balance;
  
  -- Subtract already paid amounts
  SELECT COALESCE(SUM(amount), 0) INTO _max_eligible
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid';
  
  _realized_profit := _realized_profit - _max_eligible;
  
  IF _realized_profit <= 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'No realized profit available for payout',
      'realized_profit', _realized_profit
    );
  END IF;
  
  -- Calculate max eligible payout
  _max_eligible := _realized_profit * (_cohort.payout_split_percent / 100.0);
  
  -- Apply percentage cap
  _max_eligible := LEAST(_max_eligible, _realized_profit * (_cohort.max_payout_percent / 100.0));
  
  -- Apply absolute cap if set
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout
  );
END;
$$;

-- 9. Helper function to detect trade correlations (MVP)
CREATE OR REPLACE FUNCTION public.detect_trade_correlations(
  _account_id uuid,
  _time_window_seconds integer DEFAULT 60,
  _min_correlation_score numeric DEFAULT 0.7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _correlations jsonb := '[]'::jsonb;
  _correlation record;
  _account_user_id uuid;
BEGIN
  -- Get the account's user_id
  SELECT user_id INTO _account_user_id FROM accounts WHERE id = _account_id;
  
  -- Find correlated trades with other accounts (same symbol, opposite side, within time window)
  FOR _correlation IN
    SELECT 
      t2.account_id as other_account_id,
      a2.account_number as other_account_number,
      a2.user_id as other_user_id,
      COUNT(*) as match_count,
      jsonb_agg(jsonb_build_object(
        'symbol', t1.symbol,
        'our_side', t1.side,
        'their_side', t2.side,
        'our_time', t1.opened_at,
        'their_time', t2.opened_at,
        'time_diff_seconds', EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))
      ) ORDER BY t1.opened_at DESC) FILTER (WHERE true) as sample_trades
    FROM trades t1
    JOIN trades t2 ON t1.symbol = t2.symbol 
      AND t1.side != t2.side
      AND t1.account_id != t2.account_id
      AND ABS(EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))) <= _time_window_seconds
    JOIN accounts a2 ON t2.account_id = a2.id
    WHERE t1.account_id = _account_id
      AND a2.user_id != _account_user_id  -- Different user
    GROUP BY t2.account_id, a2.account_number, a2.user_id
    HAVING COUNT(*) >= 3  -- At least 3 matching patterns
  LOOP
    _correlations := _correlations || jsonb_build_object(
      'other_account_id', _correlation.other_account_id,
      'other_account_number', _correlation.other_account_number,
      'match_count', _correlation.match_count,
      'correlation_type', 'opposite_side',
      'sample_trades', _correlation.sample_trades
    );
  END LOOP;
  
  RETURN jsonb_build_object(
    'has_correlations', jsonb_array_length(_correlations) > 0,
    'correlation_count', jsonb_array_length(_correlations),
    'correlations', _correlations
  );
END;
$$;

-- 10. Add trigger to update identity_clusters.updated_at
CREATE TRIGGER update_identity_clusters_updated_at
BEFORE UPDATE ON public.identity_clusters
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_payout_methods_updated_at
BEFORE UPDATE ON public.payout_methods
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();