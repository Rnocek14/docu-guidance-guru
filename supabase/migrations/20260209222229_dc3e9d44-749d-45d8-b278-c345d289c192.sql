-- ============================================================
-- CRITICAL SECURITY FIX: Revoke anon access from money-moving RPCs
-- Evidence: pg_proc.proacl shows anon=X for confirm_payout_payment,
--           ingest_trade_atomic, mark_payout_paid, validate_payout_request
-- ============================================================

-- confirm_payout_payment: service_role ONLY (webhook adapter)
REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout_payment TO service_role;

-- ingest_trade_atomic: service_role ONLY (edge function uses service key)
REVOKE EXECUTE ON FUNCTION public.ingest_trade_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ingest_trade_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.ingest_trade_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_trade_atomic TO service_role;

-- mark_payout_paid: service_role ONLY (called by payout-actions edge function)
REVOKE EXECUTE ON FUNCTION public.mark_payout_paid FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_payout_paid FROM anon;
REVOKE EXECUTE ON FUNCTION public.mark_payout_paid FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_paid TO service_role;

-- validate_payout_request: authenticated ONLY (trader calls via client)
REVOKE EXECUTE ON FUNCTION public.validate_payout_request FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_payout_request FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_payout_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_payout_request TO service_role;