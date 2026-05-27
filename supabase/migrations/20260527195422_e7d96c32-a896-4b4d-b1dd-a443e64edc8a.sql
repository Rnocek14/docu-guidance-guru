UPDATE public.competitor_intel_profiles
SET urls = jsonb_build_object(
  'pricing', 'https://apextraderfunding.com/',
  'rules', 'https://apextraderfunding.com/'
)
WHERE firm_id = 'apex';