-- Remove the browserless_api_key row from system_settings.
-- The Browserless credential is now read exclusively from the
-- BROWSERLESS_API_KEY edge function secret. Storing it in system_settings
-- exposed it to risk_officer and support roles via the "Staff can view
-- settings" SELECT policy.
DELETE FROM public.system_settings WHERE key = 'browserless_api_key';