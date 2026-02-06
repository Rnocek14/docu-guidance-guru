
-- =====================================================
-- P1: Separation of Duties (approver ≠ payer)
-- =====================================================

-- Step 1: Add approved_by and paid_by columns
ALTER TABLE public.payouts 
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS paid_by uuid;

-- Step 2: Backfill approved_by from reviewed_by for existing approved/paid payouts
UPDATE public.payouts 
SET approved_by = reviewed_by 
WHERE status IN ('approved', 'paid') AND approved_by IS NULL AND reviewed_by IS NOT NULL;

-- Step 3: Rebuild mark_payout_paid with separation-of-duties check
CREATE OR REPLACE FUNCTION public.mark_payout_paid(
  _payout_id uuid,
  _payment_reference text,
  _reviewed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout record;
  _account record;
  _cohort record;
  _cohort_payout record;
  _profile record;
  _jurisdiction_check jsonb;
  _payout_amount numeric;
  _paid_at timestamptz;
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric;
  _lifetime_headroom numeric;
  _new_lifetime_paid_total numeric;
BEGIN
  -- LOCK ORDER: 1. payouts, 2. accounts, 3. user_cohort_payouts, 4. profiles
  
  -- Get payout with lock
  SELECT * INTO _payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  
  -- IDEMPOTENCY: If already paid, return success with existing data
  IF _payout.status = 'paid' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'payout', jsonb_build_object(
        'id', _payout.id,
        'account_id', _payout.account_id,
        'amount', _payout.amount,
        'status', _payout.status,
        'paid_at', _payout.paid_at,
        'payment_reference', _payout.payment_reference
      )
    );
  END IF;
  
  -- Validate: must be approved to mark paid
  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Payout must be approved before marking paid',
      'current_status', _payout.status
    );
  END IF;

  -- =====================================================
  -- SEPARATION OF DUTIES: approver cannot be the payer
  -- =====================================================
  IF _payout.approved_by IS NOT NULL AND _payout.approved_by = _reviewed_by THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Separation of duties violation: approver cannot mark payout as paid',
      'approved_by', _payout.approved_by,
      'attempted_payer', _reviewed_by,
      'hint', 'A different admin must mark this payout as paid'
    );
  END IF;
  
  _payout_amount := _payout.amount;
  
  -- HARDENING: Minimum payout defense-in-depth
  IF _payout_amount < 50 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout amount below minimum ($50)',
      'payout_amount', _payout_amount
    );
  END IF;
  
  -- Enforce amount <= calculated_eligible_amount to prevent bypass
  IF _payout.calculated_eligible_amount IS NOT NULL 
     AND _payout_amount > _payout.calculated_eligible_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout amount exceeds calculated eligible amount at approval time',
      'payout_amount', _payout_amount,
      'calculated_eligible_amount', _payout.calculated_eligible_amount,
      'hint', 'This payout was modified after approval. Re-approve with correct amount.'
    );
  END IF;
  
  -- Get account with lock
  SELECT * INTO _account 
  FROM accounts 
  WHERE id = _payout.account_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account not found');
  END IF;

  -- Get profile for freeze/hold checks (with lock for lifetime_paid_total update)
  SELECT * INTO _profile FROM profiles WHERE user_id = _account.user_id FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
  END IF;
  
  -- Check payouts_frozen (chargeback-based)
  IF _profile.payouts_frozen THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'User payouts are frozen',
      'frozen_reason', _profile.payouts_frozen_reason,
      'hint', 'Resolve chargeback issue before marking paid'
    );
  END IF;
  
  -- Check payouts_hold (geo-mismatch)
  IF _profile.payouts_hold THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'User payouts are on hold',
      'hold_reason', _profile.payouts_hold_reason,
      'hint', 'Release geo-mismatch hold before marking paid'
    );
  END IF;
  
  -- Check jurisdiction
  _jurisdiction_check := public.assert_user_jurisdiction_allowed(_account.user_id, 'payout_send');
  
  IF NOT COALESCE((_jurisdiction_check->>'allowed')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Jurisdiction blocks payout',
      'jurisdiction_reason', _jurisdiction_check->>'reason',
      'country', _jurisdiction_check->>'country'
    );
  END IF;
  
  -- Get cohort
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cohort not found');
  END IF;
  
  -- Get or create per-cohort payout tracking row with lock
  SELECT * INTO _cohort_payout
  FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
    VALUES (_account.user_id, _account.cohort_id, 0)
    ON CONFLICT (user_id, cohort_id) DO NOTHING
    RETURNING * INTO _cohort_payout;
    
    IF NOT FOUND THEN
      SELECT * INTO _cohort_payout
      FROM user_cohort_payouts
      WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id
      FOR UPDATE;
    END IF;
  END IF;
  
  _lifetime_paid_total := COALESCE(_cohort_payout.lifetime_paid_total, 0);
  _paid_at := now();
  
  -- Final lifetime cap check (defense in depth) - per cohort
  IF _cohort.entry_fee IS NOT NULL AND _cohort.lifetime_cap_multiple IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;
    
    IF _payout_amount > _lifetime_headroom THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Payout amount exceeds lifetime cap headroom for this tier',
        'payout_amount', _payout_amount,
        'lifetime_headroom', _lifetime_headroom,
        'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_paid_total', _lifetime_paid_total,
        'cohort_id', _account.cohort_id,
        'hint', 'Reduce payout amount or check tier settings'
      );
    END IF;
  END IF;
  
  -- Calculate new totals
  _new_lifetime_paid_total := _lifetime_paid_total + _payout_amount;
  
  -- Update payout status (set paid_by, keep approved_by immutable)
  UPDATE payouts
  SET status = 'paid',
      paid_at = _paid_at,
      payment_reference = _payment_reference,
      paid_by = _reviewed_by,
      reviewed_at = _paid_at,
      updated_at = _paid_at
  WHERE id = _payout_id;
  
  -- Update per-cohort lifetime paid total
  UPDATE user_cohort_payouts
  SET lifetime_paid_total = _new_lifetime_paid_total,
      updated_at = now()
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  -- Update global lifetime paid total on profile
  UPDATE profiles
  SET lifetime_paid_total = lifetime_paid_total + _payout_amount,
      updated_at = now()
  WHERE user_id = _account.user_id;
  
  -- Reset payout cycle
  UPDATE accounts
  SET payout_cycle_start_balance = _account.current_balance,
      payout_cycle_started_at = _paid_at,
      status = 'passed',
      updated_at = _paid_at
  WHERE id = _account.id;
  
  RETURN jsonb_build_object(
    'success', true,
    'payout', jsonb_build_object(
      'id', _payout_id,
      'account_id', _payout.account_id,
      'amount', _payout_amount,
      'status', 'paid',
      'paid_at', _paid_at,
      'payment_reference', _payment_reference,
      'approved_by', _payout.approved_by,
      'paid_by', _reviewed_by
    ),
    'lifetime', jsonb_build_object(
      'previous_paid_total', _lifetime_paid_total,
      'new_paid_total', _new_lifetime_paid_total,
      'cohort_id', _account.cohort_id
    )
  );
END;
$$;
