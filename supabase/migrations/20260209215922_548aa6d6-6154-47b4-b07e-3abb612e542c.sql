-- Explicitly revoke anon access to get_liability_snapshot
REVOKE EXECUTE ON FUNCTION public.get_liability_snapshot(integer, numeric, numeric) FROM anon;

-- Also lock down check_cron_health from anon
REVOKE EXECUTE ON FUNCTION public.check_cron_health() FROM anon;