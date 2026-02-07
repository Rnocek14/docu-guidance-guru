
-- === Migration: Verification Phase Schema ===

-- 1) Cohort phase + chain
ALTER TABLE public.cohorts
  ADD COLUMN next_cohort_id uuid REFERENCES public.cohorts(id),
  ADD COLUMN cohort_phase text NOT NULL DEFAULT 'evaluation';

CREATE OR REPLACE FUNCTION public.validate_cohort_phase()
RETURNS trigger AS $$
BEGIN
  IF NEW.cohort_phase NOT IN ('evaluation', 'verification', 'performance') THEN
    RAISE EXCEPTION 'Invalid cohort_phase: %. Must be evaluation, verification, or performance.', NEW.cohort_phase;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_validate_cohort_phase
  BEFORE INSERT OR UPDATE ON public.cohorts
  FOR EACH ROW EXECUTE FUNCTION public.validate_cohort_phase();

CREATE INDEX idx_cohorts_next_cohort_id ON public.cohorts(next_cohort_id);
CREATE INDEX idx_cohorts_cohort_phase ON public.cohorts(cohort_phase);

-- 2) Account lineage
ALTER TABLE public.accounts
  ADD COLUMN parent_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN root_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN phase_index integer NOT NULL DEFAULT 0;

CREATE INDEX idx_accounts_parent_account_id ON public.accounts(parent_account_id);
CREATE INDEX idx_accounts_root_account_id ON public.accounts(root_account_id);

-- 3) Phase transitions table
CREATE TABLE public.account_phase_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id uuid NOT NULL REFERENCES public.accounts(id),
  to_account_id uuid NOT NULL REFERENCES public.accounts(id),
  from_cohort_id uuid NOT NULL REFERENCES public.cohorts(id),
  to_cohort_id uuid NOT NULL REFERENCES public.cohorts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_account_phase_transitions_unique
  ON public.account_phase_transitions(from_account_id, to_cohort_id);

ALTER TABLE public.account_phase_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client inserts on phase transitions"
  ON public.account_phase_transitions FOR INSERT
  TO authenticated WITH CHECK (false);

CREATE POLICY "No client updates on phase transitions"
  ON public.account_phase_transitions FOR UPDATE
  TO authenticated USING (false);

CREATE POLICY "No client deletes on phase transitions"
  ON public.account_phase_transitions FOR DELETE
  TO authenticated USING (false);

CREATE POLICY "Staff can view phase transitions"
  ON public.account_phase_transitions FOR SELECT
  TO authenticated
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "Traders can view own phase transitions"
  ON public.account_phase_transitions FOR SELECT
  TO authenticated
  USING (
    from_account_id IN (SELECT id FROM accounts WHERE user_id = auth.uid())
    OR to_account_id IN (SELECT id FROM accounts WHERE user_id = auth.uid())
  );
