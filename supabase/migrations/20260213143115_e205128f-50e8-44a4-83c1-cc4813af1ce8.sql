
-- Fix: recreate RPCs with non-reserved CTE names

CREATE OR REPLACE FUNCTION public.get_support_ops_metrics(p_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH date_range AS (
    SELECT (now() - (p_days || ' days')::interval) AS since
  ),
  counts AS (
    SELECT
      count(*)::int AS total_emails,
      count(*) FILTER (WHERE needs_human)::int AS total_escalated
    FROM support_emails, date_range
    WHERE created_at >= date_range.since
  ),
  hall AS (
    SELECT count(*)::int AS hallucination_count
    FROM support_email_actions, date_range
    WHERE action_type = 'ai_hallucination_filtered'
      AND created_at >= date_range.since
  )
  SELECT jsonb_build_object(
    'total_emails', c.total_emails,
    'total_escalated', c.total_escalated,
    'escalation_rate', CASE WHEN c.total_emails > 0 THEN round(c.total_escalated::numeric / c.total_emails * 100, 1) ELSE 0 END,
    'hallucination_count', h.hallucination_count,
    'hallucination_rate', CASE WHEN c.total_emails > 0 THEN round(h.hallucination_count::numeric / c.total_emails * 100, 1) ELSE 0 END
  )
  FROM counts c, hall h;
$$;
