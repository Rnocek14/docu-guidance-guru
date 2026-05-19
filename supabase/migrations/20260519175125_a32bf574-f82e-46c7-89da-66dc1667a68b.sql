
CREATE OR REPLACE FUNCTION public._pa_validate()
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid      uuid;
  v_aid      uuid;
  v_cohort   uuid;
  v_user     uuid := gen_random_uuid();
  v_ps_id    uuid;
  v_aff_id   uuid;
  v_attr_id  uuid;
  v_src_id   uuid;
  v_paid_src uuid;
  v_void     jsonb;
  v_row      record;
  v_msg      text;
  v_short    text;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);

  -- Setup
  INSERT INTO cohorts (id, name, account_size, profit_target_percent, is_active)
  VALUES (gen_random_uuid(), '_pa_val_cohort_' || substr(md5(random()::text),1,6), 50000, 10, true)
  RETURNING id INTO v_cohort;

  INSERT INTO accounts (id, user_id, account_number, account_size, cohort_id, status)
  VALUES (gen_random_uuid(), v_user, 'PAVAL-' || substr(md5(random()::text),1,6), 50000, v_cohort, 'paid_confirmed')
  RETURNING id INTO v_aid;

  INSERT INTO payouts (id, account_id, amount, status, requested_at, paid_at)
  VALUES (gen_random_uuid(), v_aid, 250, 'paid_confirmed', now(), now())
  RETURNING id INTO v_pid;

  RETURN NEXT '--- TEST 5: display_name validation ---';

  -- 5a good name
  v_short := 'pav' || substr(md5(random()::text),1,8);
  BEGIN
    INSERT INTO payout_shares (payout_id, short_id, display_name, is_public)
    VALUES (v_pid, v_short, '  Trader  Joe  ', true)
    RETURNING id, display_name INTO v_row;
    IF v_row.display_name = 'Trader Joe' THEN
      RETURN NEXT 'PASS 5a: good name + whitespace collapsed -> ' || v_row.display_name;
    ELSE
      RETURN NEXT 'FAIL 5a: got "' || v_row.display_name || '"';
    END IF;
    v_ps_id := v_row.id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RETURN NEXT 'FAIL 5a: unexpected error ' || v_msg;
  END;

  -- 5b too long
  BEGIN
    INSERT INTO payout_shares (payout_id, short_id, display_name, is_public)
    VALUES (v_pid, 'pavl' || substr(md5(random()::text),1,6), repeat('a',41), true);
    RETURN NEXT 'FAIL 5b: long name accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RETURN NEXT 'PASS 5b: long rejected -> ' || v_msg;
  END;

  -- 5c invalid chars
  BEGIN
    INSERT INTO payout_shares (payout_id, short_id, display_name, is_public)
    VALUES (v_pid, 'pavc' || substr(md5(random()::text),1,6), 'Hax0r<script>', true);
    RETURN NEXT 'FAIL 5c: invalid chars accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RETURN NEXT 'PASS 5c: invalid chars rejected -> ' || v_msg;
  END;

  -- 5d impersonation
  BEGIN
    INSERT INTO payout_shares (payout_id, short_id, display_name, is_public)
    VALUES (v_pid, 'pavi' || substr(md5(random()::text),1,6), 'Meridian Admin', true);
    RETURN NEXT 'FAIL 5d: impersonation accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RETURN NEXT 'PASS 5d: impersonation blocked -> ' || v_msg;
  END;

  -- 5e profanity
  BEGIN
    INSERT INTO payout_shares (payout_id, short_id, display_name, is_public)
    VALUES (v_pid, 'pavp' || substr(md5(random()::text),1,6), 'Fuck Off', true);
    RETURN NEXT 'FAIL 5e: profanity accepted';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT 'PASS 5e: profanity blocked';
  END;

  -- 5f UPDATE path
  BEGIN
    UPDATE payout_shares SET display_name = 'Meridian Support' WHERE id = v_ps_id;
    RETURN NEXT 'FAIL 5f: UPDATE allowed impersonation';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT 'PASS 5f: UPDATE rejects impersonation';
  END;

  -- 5g public RPC
  SELECT * INTO v_row FROM get_public_payout_share(v_short);
  IF v_row.display_name = 'Trader Joe'
     AND v_row.paid_at = date_trunc('hour', v_row.paid_at) THEN
    RETURN NEXT 'PASS 5g: public RPC returns safe fields + rounded paid_at';
  ELSE
    RETURN NEXT 'FAIL 5g: name=' || COALESCE(v_row.display_name,'NULL') || ' paid_at=' || COALESCE(v_row.paid_at::text,'NULL');
  END IF;

  RETURN NEXT '--- TEST 2: void_affiliate_attribution_by_source ---';

  INSERT INTO affiliates (id, user_id, code, status, rate_initial_pct, rate_reset_pct)
  VALUES (gen_random_uuid(), gen_random_uuid(), 'VAL' || substr(md5(random()::text),1,5), 'approved', 10, 5)
  RETURNING id INTO v_aff_id;

  v_src_id := gen_random_uuid();
  INSERT INTO affiliate_attributions
    (affiliate_id, buyer_user_id, source, source_id, purchase_amount_cents, rate_pct, commission_cents, status)
  VALUES (v_aff_id, v_user, 'checkout', v_src_id, 14900, 10, 1490, 'pending')
  RETURNING id INTO v_attr_id;

  v_void := void_affiliate_attribution_by_source('checkout', v_src_id, 'refund');
  IF (v_void->>'voided')::bool
     AND (SELECT status FROM affiliate_attributions WHERE id = v_attr_id) = 'reversed' THEN
    RETURN NEXT 'PASS 2a: pending attribution voided to reversed';
  ELSE
    RETURN NEXT 'FAIL 2a: ' || v_void::text;
  END IF;

  -- already-paid not mutated
  v_paid_src := gen_random_uuid();
  INSERT INTO affiliate_attributions
    (affiliate_id, buyer_user_id, source, source_id, purchase_amount_cents, rate_pct, commission_cents, status, paid_at)
  VALUES (v_aff_id, v_user, 'reset', v_paid_src, 9900, 5, 495, 'paid', now());

  v_void := void_affiliate_attribution_by_source('reset', v_paid_src, 'refund');
  IF (v_void->>'voided')::bool = false
     AND (SELECT status FROM affiliate_attributions
          WHERE source='reset' AND source_id=v_paid_src) = 'paid' THEN
    RETURN NEXT 'PASS 2b: paid attribution preserved (voided=false)';
  ELSE
    RETURN NEXT 'FAIL 2b: void=' || v_void::text;
  END IF;

  -- 2c idempotency: voiding same already-reversed row returns voided=false
  v_void := void_affiliate_attribution_by_source('checkout', v_src_id, 'refund');
  IF (v_void->>'voided')::bool = false THEN
    RETURN NEXT 'PASS 2c: re-voiding reversed row is idempotent';
  ELSE
    RETURN NEXT 'FAIL 2c: re-void mutated row ' || v_void::text;
  END IF;

  -- 2d bad source rejected
  BEGIN
    PERFORM void_affiliate_attribution_by_source('garbage', gen_random_uuid(), 'refund');
    RETURN NEXT 'FAIL 2d: bad source accepted';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEXT 'PASS 2d: bad source rejected';
  END;

  -- Cleanup
  DELETE FROM affiliate_attributions WHERE affiliate_id = v_aff_id;
  DELETE FROM affiliates WHERE id = v_aff_id;
  DELETE FROM payout_shares WHERE payout_id = v_pid;
  DELETE FROM payouts WHERE id = v_pid;
  DELETE FROM accounts WHERE id = v_aid;
  DELETE FROM cohorts WHERE id = v_cohort;

  RETURN NEXT '--- DONE ---';
END;
$$;

REVOKE ALL ON FUNCTION public._pa_validate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pa_validate() TO service_role;
