-- Defensive fix: Use COALESCE for velocity check timestamp
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
  _lifetime_cap_applied boolean;
  _lifetime_cap_amount numeric;
  _lifetime_headroom numeric;
  _account_status text;
  _pending_payout_count integer;
  _recent_request_count integer;
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
  
  -- ============================================
  -- VELOCITY LIMIT (max 3 open requests per 24h)
  -- Uses COALESCE for defensive timestamp handling
  -- ============================================
  SELECT COUNT(*) INTO _recent_request_count
  FROM payouts
  WHERE account_id = _account_id
    AND status IN ('pending', 'under_review', 'approved')
    AND COALESCE(requested_at, now()) >= now() - interval '24 hours';

  IF _recent_request_count >= 3 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Too many payout requests in the last 24 hours',
      'recent_request_count', _recent_request_count,
      'max_requests_per_day', 3,
      'hint', 'Please wait before submitting another payout request'
    );
  END IF;
  -- ============================================
  
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
  _lifetime_cap_applied := COALESCE((_eligibility->>'lifetime_cap_applied')::boolean, false);
  
  _first_payout_cap_amount := CASE
    WHEN (_eligibility ? 'first_payout_cap_amount')
     AND (_eligibility->>'first_payout_cap_amount') IS NOT NULL
     AND (_eligibility->>'first_payout_cap_amount') NOT IN ('', 'null')
    THEN (_eligibility->>'first_payout_cap_amount')::numeric
    ELSE NULL
  END;
  
  _lifetime_cap_amount := CASE
    WHEN (_eligibility ? 'lifetime_cap_amount')
     AND (_eligibility->>'lifetime_cap_amount') IS NOT NULL
     AND (_eligibility->>'lifetime_cap_amount') NOT IN ('', 'null')
    THEN (_eligibility->>'lifetime_cap_amount')::numeric
    ELSE NULL
  END;
  
  _lifetime_headroom := CASE
    WHEN (_eligibility ? 'lifetime_headroom')
     AND (_eligibility->>'lifetime_headroom') IS NOT NULL
     AND (_eligibility->>'lifetime_headroom') NOT IN ('', 'null')
    THEN (_eligibility->>'lifetime_headroom')::numeric
    ELSE NULL
  END;
  
  IF _requested_amount > _max_eligible THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', CASE 
        WHEN _lifetime_cap_applied
        THEN 'Lifetime payout cap applies for this tier: maximum $' || ROUND(_lifetime_headroom, 2) || ' remaining'
        WHEN _first_payout_cap_applied 
        THEN 'First payout cap applies: maximum $' || _first_payout_cap_amount || ' for first payout in cycle'
        ELSE 'Requested amount exceeds maximum eligible payout'
      END,
      'requested_amount', _requested_amount,
      'max_eligible_amount', _max_eligible,
      'max_eligible_before_first_cap', _max_eligible_before_cap,
      'first_payout_cap_applied', _first_payout_cap_applied,
      'first_payout_cap_amount', _first_payout_cap_amount,
      'lifetime_cap_applied', _lifetime_cap_applied,
      'lifetime_cap_amount', _lifetime_cap_amount,
      'lifetime_headroom', _lifetime_headroom,
      'hint', CASE 
        WHEN _lifetime_cap_applied
        THEN 'You are approaching or have reached your lifetime payout cap for this tier.'
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
    'lifetime_cap_applied', _lifetime_cap_applied,
    'lifetime_cap_amount', _lifetime_cap_amount,
    'lifetime_headroom', _lifetime_headroom,
    'is_first_payout_in_cycle', (_eligibility->>'is_first_payout_in_cycle')::boolean,
    'eligibility_details', _eligibility
  );
END;
$function$;