
CREATE OR REPLACE FUNCTION public.get_liability_buffer_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.liability_buffer_settings%rowtype;
BEGIN
  -- Service role (cron/edge functions): return the most recently updated settings
  IF auth.role() = 'service_role' THEN
    SELECT * INTO s
    FROM public.liability_buffer_settings
    ORDER BY updated_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'cash_reserve', 0,
        'assumed_avg_first_payout', 300
      );
    END IF;

    RETURN jsonb_build_object(
      'cash_reserve', s.cash_reserve,
      'assumed_avg_first_payout', s.assumed_avg_first_payout
    );
  END IF;

  -- Authenticated users: require staff role, scope to own settings
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  SELECT * INTO s
  FROM public.liability_buffer_settings
  WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'cash_reserve', 0,
      'assumed_avg_first_payout', 300
    );
  END IF;

  RETURN jsonb_build_object(
    'cash_reserve', s.cash_reserve,
    'assumed_avg_first_payout', s.assumed_avg_first_payout
  );
END;
$$;
