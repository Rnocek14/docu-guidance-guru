-- =====================================================================
-- #8: Net commission math
-- =====================================================================
CREATE OR REPLACE FUNCTION public.estimate_stripe_fee_cents(p_amount_cents integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- Standard Stripe US card pricing: 2.9% + 30¢. International cards
  -- and disputes are not modeled here; this is an estimator used only
  -- to right-size affiliate commission, not to settle with Stripe.
  SELECT CASE
    WHEN COALESCE(p_amount_cents, 0) <= 0 THEN 0
    ELSE LEAST(p_amount_cents, (ROUND(p_amount_cents * 0.029)::int + 30))
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.estimate_stripe_fee_cents(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estimate_stripe_fee_cents(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_affiliate_attribution(
  p_source text,
  p_source_id uuid,
  p_code text,
  p_buyer_user_id uuid,
  p_amount_cents integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_aff public.affiliates;
  v_rate numeric;
  v_fee_cents integer;
  v_net_cents integer;
  v_commission integer;
  v_id uuid;
begin
  if p_code is null or p_amount_cents is null or p_amount_cents <= 0 then
    return null;
  end if;

  if p_source not in ('checkout','reset') then
    raise exception 'BAD_SOURCE';
  end if;

  select * into v_aff
  from public.affiliates
  where code = upper(trim(p_code))
    and status = 'approved'
  limit 1;

  if not found then
    return null;
  end if;

  if v_aff.user_id = p_buyer_user_id then
    return null;
  end if;

  v_rate := case when p_source = 'checkout' then v_aff.rate_initial_pct else v_aff.rate_reset_pct end;

  -- Net basis: gross minus estimated Stripe processing fee.
  v_fee_cents := public.estimate_stripe_fee_cents(p_amount_cents);
  v_net_cents := greatest(0, p_amount_cents - v_fee_cents);
  v_commission := floor(v_net_cents * v_rate / 100.0)::int;

  insert into public.affiliate_attributions
    (affiliate_id, buyer_user_id, source, source_id, purchase_amount_cents,
     rate_pct, commission_cents, status, notes)
  values
    (v_aff.id, p_buyer_user_id, p_source, p_source_id, p_amount_cents,
     v_rate, v_commission, 'pending',
     'net_basis_cents=' || v_net_cents::text || ' fee_cents=' || v_fee_cents::text)
  on conflict (source, source_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- =====================================================================
-- #7: Affiliate self-heal — replays missed attributions
-- =====================================================================
CREATE OR REPLACE FUNCTION public.heal_missing_affiliate_attributions(
  p_lookback_hours integer DEFAULT 168
)
RETURNS TABLE(source text, source_id uuid, attribution_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  r record;
  v_id uuid;
  v_cutoff timestamptz := now() - make_interval(hours => GREATEST(1, p_lookback_hours));
begin
  if not public.has_role(auth.uid(), 'admin'::public.app_role) then
    raise exception 'ADMIN_ONLY';
  end if;

  -- Checkout fulfillment rows that paid and reference an affiliate code
  -- but never produced an attribution row.
  for r in
    select q.id as src_id, q.affiliate_code, q.user_id, q.amount_cents
    from public.checkout_fulfillment_queue q
    where q.affiliate_code is not null
      and q.affiliate_code <> ''
      and q.status = 'fulfilled'
      and q.created_at >= v_cutoff
      and not exists (
        select 1 from public.affiliate_attributions a
        where a.source = 'checkout' and a.source_id = q.id
      )
  loop
    v_id := public.record_affiliate_attribution(
      'checkout', r.src_id, r.affiliate_code, r.user_id,
      COALESCE(r.amount_cents, 0)
    );
    if v_id is not null then
      source := 'checkout'; source_id := r.src_id; attribution_id := v_id;
      return next;
    end if;
  end loop;

  -- Reset purchases (paid + applied) that reference an affiliate code
  -- but never produced an attribution row.
  for r in
    select rp.id as src_id, rp.affiliate_code, rp.user_id, rp.amount_paid_cents
    from public.reset_purchases rp
    where rp.affiliate_code is not null
      and rp.affiliate_code <> ''
      and rp.status = 'paid'
      and rp.applied_at is not null
      and rp.created_at >= v_cutoff
      and not exists (
        select 1 from public.affiliate_attributions a
        where a.source = 'reset' and a.source_id = rp.id
      )
  loop
    v_id := public.record_affiliate_attribution(
      'reset', r.src_id, r.affiliate_code, r.user_id,
      COALESCE(r.amount_paid_cents, 0)
    );
    if v_id is not null then
      source := 'reset'; source_id := r.src_id; attribution_id := v_id;
      return next;
    end if;
  end loop;

  return;
end;
$$;

REVOKE EXECUTE ON FUNCTION public.heal_missing_affiliate_attributions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heal_missing_affiliate_attributions(integer) TO authenticated;

-- =====================================================================
-- #11: Strip tier_name from public payout RPCs
-- =====================================================================
DROP FUNCTION IF EXISTS public.get_public_payout_share(text);
CREATE OR REPLACE FUNCTION public.get_public_payout_share(_short_id text)
RETURNS TABLE(short_id text, display_name text, amount numeric, paid_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ps.short_id,
         COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'),
         p.amount,
         date_trunc('hour', p.paid_at)
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id = ps.payout_id
  WHERE ps.short_id = _short_id
    AND ps.is_public = true
    AND p.status IN ('paid','paid_confirmed')
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_public_payout_share(text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_recent_public_payouts(integer);
CREATE OR REPLACE FUNCTION public.get_recent_public_payouts(_limit integer DEFAULT 20)
RETURNS TABLE(short_id text, display_name text, amount numeric, paid_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ps.short_id,
         COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'),
         p.amount,
         date_trunc('hour', p.paid_at)
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id = ps.payout_id
  WHERE ps.is_public = true
    AND p.status IN ('paid','paid_confirmed')
  ORDER BY p.paid_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(_limit,1),100);
$$;
GRANT EXECUTE ON FUNCTION public.get_recent_public_payouts(integer) TO anon, authenticated;