
-- Fix: Include consistency fields + cohort_phase in rule snapshot freeze trigger
CREATE OR REPLACE FUNCTION public.freeze_account_rules()
RETURNS TRIGGER AS $$
BEGIN
  -- On INSERT: capture the cohort rules as a frozen snapshot
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_build_object(
      'cohort_id', c.id,
      'cohort_name', c.name,
      'cohort_version', c.version,
      'cohort_phase', c.cohort_phase,
      'max_daily_loss_percent', c.max_daily_loss_percent,
      'max_total_drawdown_percent', c.max_total_drawdown_percent,
      'profit_target_percent', c.profit_target_percent,
      'min_trading_days', c.min_trading_days,
      'max_position_size_percent', c.max_position_size_percent,
      'max_daily_profit_cap_percent', c.max_daily_profit_cap_percent,
      'min_profitable_days', c.min_profitable_days,
      'frozen_at', now()
    )
    INTO NEW.rule_snapshot
    FROM public.cohorts c
    WHERE c.id = NEW.cohort_id;
    
    RETURN NEW;
  END IF;
  
  -- On UPDATE: prevent changes to cohort_id or rule_snapshot
  IF TG_OP = 'UPDATE' THEN
    IF OLD.cohort_id IS DISTINCT FROM NEW.cohort_id THEN
      RAISE EXCEPTION 'Cannot change cohort_id after account creation';
    END IF;
    
    IF OLD.rule_snapshot IS DISTINCT FROM NEW.rule_snapshot THEN
      RAISE EXCEPTION 'Cannot modify rule_snapshot - rules are frozen at account creation';
    END IF;
    
    RETURN NEW;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
