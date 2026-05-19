
-- ============================================================
-- Affiliate scaffold (Workstream 3)
-- ============================================================

create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  code text not null unique check (length(code) between 3 and 32 and code ~ '^[A-Z0-9_-]+$'),
  rate_initial_pct numeric not null default 25 check (rate_initial_pct >= 0 and rate_initial_pct <= 100),
  rate_reset_pct numeric not null default 10 check (rate_reset_pct >= 0 and rate_reset_pct <= 100),
  payout_method text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  notes text,
  applied_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_affiliates_status on public.affiliates(status);
create index if not exists idx_affiliates_code on public.affiliates(code) where status = 'approved';

alter table public.affiliates enable row level security;

create policy "Users view own affiliate row" on public.affiliates
  for select to authenticated using (user_id = auth.uid());

create policy "Admins view all affiliates" on public.affiliates
  for select to authenticated using (has_role(auth.uid(), 'admin'::app_role));

create policy "Admins manage affiliates" on public.affiliates
  for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create policy "No client inserts on affiliates" on public.affiliates
  for insert to authenticated with check (false);

-- ============================================================
-- affiliate_attributions
-- ============================================================
create table if not exists public.affiliate_attributions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete restrict,
  buyer_user_id uuid not null,
  source text not null check (source in ('checkout','reset')),
  source_id uuid not null,
  purchase_amount_cents integer not null check (purchase_amount_cents >= 0),
  rate_pct numeric not null check (rate_pct >= 0 and rate_pct <= 100),
  commission_cents integer not null check (commission_cents >= 0),
  status text not null default 'pending' check (status in ('pending','approved','paid','reversed')),
  notes text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_by uuid,
  paid_reference text,
  unique (source, source_id)
);

create index if not exists idx_attrib_affiliate_status on public.affiliate_attributions(affiliate_id, status);
create index if not exists idx_attrib_created on public.affiliate_attributions(created_at desc);

alter table public.affiliate_attributions enable row level security;

create policy "Affiliates view own attributions" on public.affiliate_attributions
  for select to authenticated
  using (affiliate_id in (select id from public.affiliates where user_id = auth.uid()));

create policy "Admins view all attributions" on public.affiliate_attributions
  for select to authenticated using (has_role(auth.uid(), 'admin'::app_role));

create policy "Admins manage attributions" on public.affiliate_attributions
  for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create policy "No client inserts on attributions" on public.affiliate_attributions
  for insert to authenticated with check (false);

-- ============================================================
-- Stamp referral code on purchase rows
-- ============================================================
alter table public.checkout_fulfillment_queue
  add column if not exists affiliate_code text;

alter table public.reset_purchases
  add column if not exists affiliate_code text;

-- ============================================================
-- RPCs
-- ============================================================

-- Trader self-apply (creates pending row)
create or replace function public.apply_for_affiliate(
  p_code text,
  p_payout_method text default null
)
returns public.affiliates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(p_code));
  v_row public.affiliates;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if v_code is null or length(v_code) < 3 or v_code !~ '^[A-Z0-9_-]+$' then
    raise exception 'INVALID_CODE';
  end if;

  insert into public.affiliates (user_id, code, payout_method, status)
  values (v_uid, v_code, nullif(trim(coalesce(p_payout_method,'')), ''), 'pending')
  returning * into v_row;

  return v_row;
exception
  when unique_violation then
    raise exception 'CODE_OR_USER_TAKEN';
end;
$$;

revoke all on function public.apply_for_affiliate(text, text) from public;
grant execute on function public.apply_for_affiliate(text, text) to authenticated;

-- Public lookup: validates code exists + is approved (used at click time, no PII)
create or replace function public.get_affiliate_by_code(p_code text)
returns table(id uuid, code text, status text)
language sql
security definer
stable
set search_path = public
as $$
  select id, code, status
  from public.affiliates
  where code = upper(trim(p_code))
    and status = 'approved'
  limit 1;
$$;

revoke all on function public.get_affiliate_by_code(text) from public;
grant execute on function public.get_affiliate_by_code(text) to anon, authenticated;

-- Server-side attribution recorder. Called by webhook handlers AFTER fulfillment.
-- Idempotent via (source, source_id) unique constraint.
-- Blocks self-referral (affiliate.user_id == buyer).
create or replace function public.record_affiliate_attribution(
  p_source text,
  p_source_id uuid,
  p_code text,
  p_buyer_user_id uuid,
  p_amount_cents integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aff public.affiliates;
  v_rate numeric;
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

  -- Block self-referral
  if v_aff.user_id = p_buyer_user_id then
    return null;
  end if;

  v_rate := case when p_source = 'checkout' then v_aff.rate_initial_pct else v_aff.rate_reset_pct end;
  v_commission := floor(p_amount_cents * v_rate / 100.0)::int;

  insert into public.affiliate_attributions
    (affiliate_id, buyer_user_id, source, source_id, purchase_amount_cents, rate_pct, commission_cents, status)
  values
    (v_aff.id, p_buyer_user_id, p_source, p_source_id, p_amount_cents, v_rate, v_commission, 'pending')
  on conflict (source, source_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_affiliate_attribution(text, uuid, text, uuid, integer) from public;
-- Only callable via service role; do NOT grant to authenticated.

-- Admin: mark attribution paid
create or replace function public.mark_affiliate_attribution_paid(
  p_attribution_id uuid,
  p_paid_reference text default null
)
returns public.affiliate_attributions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.affiliate_attributions;
begin
  if not has_role(v_uid, 'admin'::app_role) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  update public.affiliate_attributions
  set status = 'paid',
      paid_at = now(),
      paid_by = v_uid,
      paid_reference = nullif(trim(coalesce(p_paid_reference,'')), '')
  where id = p_attribution_id
    and status in ('pending','approved')
  returning * into v_row;

  if not found then
    raise exception 'NOT_FOUND_OR_WRONG_STATE';
  end if;

  return v_row;
end;
$$;

revoke all on function public.mark_affiliate_attribution_paid(uuid, text) from public;
grant execute on function public.mark_affiliate_attribution_paid(uuid, text) to authenticated;

-- Trigger to keep affiliates.updated_at fresh
create or replace function public._affiliates_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_affiliates_touch on public.affiliates;
create trigger trg_affiliates_touch before update on public.affiliates
  for each row execute function public._affiliates_touch_updated_at();
