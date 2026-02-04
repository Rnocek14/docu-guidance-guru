-- Fix Edge Case A: Safe null handling in validate_payout_request
-- Fix Edge Case B: Enforce amount <= calculated_eligible_amount in mark_paid

-- 1) Update validate_payout_request with safe null handling
CREATE OR REPLACE FUNCTION public.validate_payout_request(_account_id uuid, _requested_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _eligibility jsonb;
  _max_eligible numeric;
  _max_eligible_before_cap numeric;
  _first_payout_cap_applied boolean;
  _first_payout_cap_amount numeric;
  _account_status text;
  _pending_payout_count integer;
BEGIN
  SELECT status INTO _account_status FROM accounts WHERE id = _account_id;
  
  IF _account_status IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  IF _account_status NOT IN ('passed') THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Account must be in passed status to request payout',
      'current_status', _account_status,
      'hint', CASE 
        WHEN _account_status IN ('payout_requested', 'payout_under_review', 'payout_approved') 
          THEN 'Account already has an active payout request'
        WHEN _account_status IN ('active', 'breached_detected', 'under_review')
          THEN 'Account must pass evaluation before requesting payout'
        WHEN _account_status IN ('failed_confirmed', 'closed')
          THEN 'Account is not eligible for payouts'
        ELSE 'Invalid account status for payout request'
      END
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_payout_count
  FROM payouts
  WHERE account_id = _account_id AND status IN ('pending', 'under_review', 'approved');
  
  IF _pending_payout_count > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'An active payout request already exists for this account',
      'pending_payout_count', _pending_payout_count,
      'hint', 'Wait for current payout to be processed before requesting another'
    );
  END IF;
  
  _eligibility := calculate_payout_eligibility(_account_id);
  
  IF NOT (_eligibility->>'eligible')::boolean THEN
    RETURN _eligibility;
  END IF;
  
  _max_eligible := (_eligibility->>'max_eligible_amount')::numeric;
  _max_eligible_before_cap := (_eligibility->>'max_eligible_before_first_cap')::numeric;
  _first_payout_cap_applied := COALESCE((_eligibility->>'first_payout_cap_applied')::boolean, false);
  
  -- FIX Edge Case A: Safe null handling for first_payout_cap_amount
  _first_payout_cap_amount := CASE
    WHEN (_eligibility ? 'first_payout_cap_amount')
     AND (_eligibility->>'first_payout_cap_amount') IS NOT NULL
     AND (_eligibility->>'first_payout_cap_amount') NOT IN ('', 'null')
    THEN (_eligibility->>'first_payout_cap_amount')::numeric
    ELSE NULL
  END;
  
  IF _requested_amount > _max_eligible THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', CASE 
        WHEN _first_payout_cap_applied 
        THEN 'First payout cap applies: maximum $' || _first_payout_cap_amount || ' for first payout in cycle'
        ELSE 'Requested amount exceeds maximum eligible payout'
      END,
      'requested_amount', _requested_amount,
      'max_eligible_amount', _max_eligible,
      'max_eligible_before_first_cap', _max_eligible_before_cap,
      'first_payout_cap_applied', _first_payout_cap_applied,
      'first_payout_cap_amount', _first_payout_cap_amount,
      'hint', CASE 
        WHEN _first_payout_cap_applied 
        THEN 'Your first payout each cycle is capped. Subsequent payouts in this cycle are not capped.'
        ELSE NULL
      END
    );
  END IF;
  
  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Minimum payout amount is $50',
      'requested_amount', _requested_amount,
      'minimum_amount', 50
    );
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'requested_amount', _requested_amount,
    'max_eligible_amount', _max_eligible,
    'max_eligible_before_first_cap', _max_eligible_before_cap,
    'first_payout_cap_applied', _first_payout_cap_applied,
    'first_payout_cap_amount', _first_payout_cap_amount,
    'is_first_payout_in_cycle', (_eligibility->>'is_first_payout_in_cycle')::boolean,
    'eligibility_details', _eligibility
  );
END;
$function$;

-- 2) Update mark_payout_paid to enforce amount <= calculated_eligible_amount (Edge Case B)
CREATE OR REPLACE FUNCTION public.mark_payout_paid(_payout_id uuid, _payment_reference text, _reviewed_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _payout record;
  _account_id uuid;
  _current_balance numeric;
  _payout_amount numeric;
  _paid_at timestamptz;
BEGIN
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
  
  -- FIX Edge Case B: Enforce amount <= calculated_eligible_amount to prevent bypass
  IF _payout.calculated_eligible_amount IS NOT NULL 
     AND _payout.amount > _payout.calculated_eligible_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout amount exceeds calculated eligible amount at approval time',
      'payout_amount', _payout.amount,
      'calculated_eligible_amount', _payout.calculated_eligible_amount,
      'hint', 'This payout was modified after approval. Re-approve with correct amount.'
    );
  END IF;
  
  _account_id := _payout.account_id;
  _payout_amount := _payout.amount;
  _paid_at := now();
  
  -- Update payout to paid (atomically)
  UPDATE payouts
  SET
    status = 'paid',
    paid_at = _paid_at,
    payment_reference = _payment_reference,
    reviewed_by = COALESCE(_reviewed_by, reviewed_by),
    reviewed_at = _paid_at
  WHERE id = _payout_id;
  
  -- Reset payout cycle (atomically in same transaction)
  SELECT current_balance INTO _current_balance
  FROM accounts
  WHERE id = _account_id;
  
  UPDATE accounts
  SET
    payout_cycle_start_balance = _current_balance,
    payout_cycle_started_at = _paid_at,
    highest_balance = _current_balance,
    status = 'passed'  -- Return to passed state after payout
  WHERE id = _account_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'payout', jsonb_build_object(
      'id', _payout_id,
      'account_id', _account_id,
      'amount', _payout_amount,
      'status', 'paid',
      'paid_at', _paid_at,
      'payment_reference', _payment_reference
    ),
    'cycle_reset', jsonb_build_object(
      'new_baseline', _current_balance,
      'reset_at', _paid_at
    )
  );
END;
$function$;