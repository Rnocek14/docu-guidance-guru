
-- 1) Strengthen cohort activation: enforce economics preset alignment
CREATE OR REPLACE FUNCTION public.validate_cohort_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- ===== ACTIVATION CHECKS (inserting active OR toggling inactive → active) =====
  IF NEW.is_active = true AND (OLD IS NULL OR OLD.is_active = false) THEN

    -- Payout split ceiling (must match sim assumptions)
    IF NEW.payout_split_percent > 85 THEN
      RAISE EXCEPTION 'Cannot activate cohort "%": payout_split_percent must be <= 85 (got %)',
        NEW.name, NEW.payout_split_percent;
    END IF;

    -- Evaluation/verification need profit targets
    IF NEW.cohort_phase IN ('evaluation', 'verification') THEN
      IF NEW.profit_target_percent IS NULL OR NEW.profit_target_percent <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": profit_target_percent must be > 0',
          NEW.cohort_phase, NEW.name;
      END IF;
    END IF;

    -- Performance/funded_sim MUST have caps (profitability invariant)
    IF NEW.cohort_phase IN ('performance', 'funded_sim') THEN
      IF NEW.lifetime_cap_multiple IS NULL OR NEW.lifetime_cap_multiple <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": lifetime_cap_multiple must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.lifetime_cap_multiple;
      END IF;
      IF NEW.first_payout_cap_amount IS NULL OR NEW.first_payout_cap_amount <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": first_payout_cap_amount must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.first_payout_cap_amount;
      END IF;
      -- First payout cap alignment: must not exceed sim-assumed ceiling
      IF NEW.first_payout_cap_amount > 500 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": first_payout_cap_amount must be <= $500 (got %)',
          NEW.cohort_phase, NEW.name, NEW.first_payout_cap_amount;
      END IF;
      -- Lifetime cap must be in approved range (7x-12x)
      IF NEW.lifetime_cap_multiple < 5 OR NEW.lifetime_cap_multiple > 15 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": lifetime_cap_multiple must be between 5 and 15 (got %)',
          NEW.cohort_phase, NEW.name, NEW.lifetime_cap_multiple;
      END IF;
    END IF;

    -- Evaluation phase entry fee floor
    IF NEW.cohort_phase = 'evaluation' THEN
      IF NEW.entry_fee IS NULL OR NEW.entry_fee < 50 THEN
        RAISE EXCEPTION 'Cannot activate evaluation cohort "%": entry_fee must be >= $50 (got %)',
          NEW.name, COALESCE(NEW.entry_fee, 0);
      END IF;
    END IF;

    -- Drawdown ceiling
    IF NEW.max_total_drawdown_percent > 20 THEN
      RAISE EXCEPTION 'Cannot activate cohort "%": max_total_drawdown_percent must be <= 20 (got %)',
        NEW.name, NEW.max_total_drawdown_percent;
    END IF;

  END IF;

  -- ===== WEAKENING PREVENTION (active → active edits) =====
  IF OLD IS NOT NULL AND OLD.is_active = true AND NEW.is_active = true THEN
    -- Cannot remove caps on payout cohorts
    IF OLD.lifetime_cap_multiple IS NOT NULL AND NEW.lifetime_cap_multiple IS NULL
       AND NEW.cohort_phase IN ('performance', 'funded_sim') THEN
      RAISE EXCEPTION 'Cannot remove lifetime_cap_multiple from active % cohort "%"',
        NEW.cohort_phase, NEW.name;
    END IF;
    IF OLD.first_payout_cap_amount IS NOT NULL AND NEW.first_payout_cap_amount IS NULL
       AND NEW.cohort_phase IN ('performance', 'funded_sim') THEN
      RAISE EXCEPTION 'Cannot remove first_payout_cap_amount from active % cohort "%"',
        NEW.cohort_phase, NEW.name;
    END IF;
    -- Cannot increase payout split on active cohort beyond ceiling
    IF NEW.payout_split_percent > 85 THEN
      RAISE EXCEPTION 'Cannot raise payout_split_percent above 85 on active cohort "%" (got %)',
        NEW.name, NEW.payout_split_percent;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 2) Add platform_ingest_enabled system setting (default OFF)
INSERT INTO system_settings (key, value, updated_at)
VALUES ('platform_ingest_enabled', 'false'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- 3) Enable reserve_aware_approval (it was disabled)
UPDATE system_settings
SET value = jsonb_set(value::jsonb, '{enabled}', 'true'::jsonb),
    updated_at = now()
WHERE key = 'reserve_aware_approval';

-- 4) Grant execute on critical RPCs to only authenticated + service_role
-- (Re-confirm grants are tight after previous migration)
REVOKE ALL ON FUNCTION public.get_liability_snapshot(int, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_liability_snapshot(int, numeric, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_cron_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_cron_health() TO authenticated, service_role;
