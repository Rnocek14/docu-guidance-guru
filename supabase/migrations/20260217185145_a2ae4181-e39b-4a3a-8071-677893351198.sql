-- Add overall_verdict text column to distinguish FAIL vs INCOMPLETE
ALTER TABLE public.collapse_sim_runs
  ADD COLUMN overall_verdict text NOT NULL DEFAULT 'incomplete';

-- Backfill existing rows
UPDATE public.collapse_sim_runs
  SET overall_verdict = CASE WHEN overall_pass THEN 'pass' ELSE 'fail' END;