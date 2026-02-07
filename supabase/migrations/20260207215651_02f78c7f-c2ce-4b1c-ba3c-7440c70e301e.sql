-- ============================================================
-- Fix RPC privileges: REVOKE from PUBLIC didn't stick for new functions.
-- Supabase re-grants default privileges on function creation.
-- Must explicitly revoke from anon + authenticated + PUBLIC.
-- ============================================================

-- detect_cross_instrument_correlations: service_role ONLY
REVOKE ALL ON FUNCTION public.detect_cross_instrument_correlations(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detect_cross_instrument_correlations(uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.detect_cross_instrument_correlations(uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.detect_cross_instrument_correlations(uuid, integer, integer) TO service_role;

-- get_rolling_pass_rate: service_role + authenticated (staff use it from UI)
REVOKE ALL ON FUNCTION public.get_rolling_pass_rate(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_rolling_pass_rate(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_rolling_pass_rate(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_rolling_pass_rate(integer) TO authenticated;