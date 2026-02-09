CREATE OR REPLACE FUNCTION public.validate_cohort_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active = true AND (OLD IS NULL OR OLD.is_active = false) THEN

    IF NEW.payout_split_percent > 85 THEN
      RAISE EXCEPTION 'Cannot activate cohort "%": payout_split_percent must be <= 85 (got %)',
        NEW.name, NEW.payout_split_percent;
    END IF;

    IF NEW.cohort_phase IN ('evaluation', 'verification') THEN
      IF NEW.profit_target_percent IS NULL OR NEW.profit_target_percent <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": profit_target_percent must be > 0',
          NEW.cohort_phase, NEW.name;
      END IF;
    END IF;

    IF NEW.cohort_phase IN ('performance', 'funded_sim') THEN
      IF NEW.lifetime_cap_multiple IS NULL OR NEW.lifetime_cap_multiple <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": lifetime_cap_multiple must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.lifetime_cap_multiple;
      END IF;
      IF NEW.first_payout_cap_amount IS NULL OR NEW.first_payout_cap_amount <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": first_payout_cap_amount must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.first_payout_cap_amount;
      END IF;
    END IF;

    IF NEW.cohort_phase = 'evaluation' THEN
      IF NEW.entry_fee IS NULL OR NEW.entry_fee < 50 THEN
        RAISE EXCEPTION 'Cannot activate evaluation cohort "%": entry_fee must be >= $50 (got %)',
          NEW.name, COALESCE(NEW.entry_fee, 0);
      END IF;
    END IF;

    IF NEW.max_total_drawdown_percent > 20 THEN
      RAISE EXCEPTION 'Cannot activate cohort "%": max_total_drawdown_percent must be <= 20 (got %)',
        NEW.name, NEW.max_total_drawdown_percent;
    END IF;

  END IF;

  -- Prevent weakening caps on already-active payout cohorts
  IF OLD IS NOT NULL AND OLD.is_active = true AND NEW.is_active = true THEN
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
  END IF;

  RETURN NEW;
END;
$$;