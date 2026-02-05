-- Create table for persisting liability buffer settings per staff user
CREATE TABLE IF NOT EXISTS public.liability_buffer_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cash_reserve numeric NOT NULL DEFAULT 0,
  assumed_avg_first_payout numeric NOT NULL DEFAULT 300,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.liability_buffer_settings ENABLE ROW LEVEL SECURITY;

-- Staff-only read policy
CREATE POLICY "Staff can read own buffer settings"
ON public.liability_buffer_settings
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid() 
  AND has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role])
);

-- Staff-only insert policy
CREATE POLICY "Staff can insert own buffer settings"
ON public.liability_buffer_settings
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role])
);

-- Staff-only update policy
CREATE POLICY "Staff can update own buffer settings"
ON public.liability_buffer_settings
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role])
);

-- RPC to read settings (staff-gated)
CREATE OR REPLACE FUNCTION public.get_liability_buffer_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s public.liability_buffer_settings%rowtype;
BEGIN
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

-- RPC to upsert settings (staff-gated)
CREATE OR REPLACE FUNCTION public.upsert_liability_buffer_settings(
  _cash_reserve numeric,
  _assumed_avg_first_payout numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _cr numeric;
  _avg numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  -- Input clamping
  _cr := GREATEST(COALESCE(_cash_reserve, 0), 0);
  _avg := LEAST(GREATEST(COALESCE(_assumed_avg_first_payout, 300), 0), 100000);

  INSERT INTO public.liability_buffer_settings(user_id, cash_reserve, assumed_avg_first_payout, updated_at)
  VALUES (auth.uid(), _cr, _avg, now())
  ON CONFLICT (user_id)
  DO UPDATE SET 
    cash_reserve = EXCLUDED.cash_reserve,
    assumed_avg_first_payout = EXCLUDED.assumed_avg_first_payout,
    updated_at = now();

  RETURN jsonb_build_object(
    'cash_reserve', _cr,
    'assumed_avg_first_payout', _avg
  );
END;
$$;