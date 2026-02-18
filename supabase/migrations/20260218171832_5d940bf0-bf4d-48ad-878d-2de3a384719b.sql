-- Fix #1: Make pass_rate nullable (it stores NULL when telemetry is missing)
ALTER TABLE public.cpc_snapshots
  ALTER COLUMN pass_rate DROP NOT NULL,
  ALTER COLUMN pass_rate DROP DEFAULT;

-- Fix #2: Rename pending_liability → in_flight_payouts for clarity
ALTER TABLE public.cpc_snapshots
  RENAME COLUMN pending_liability TO in_flight_payouts;