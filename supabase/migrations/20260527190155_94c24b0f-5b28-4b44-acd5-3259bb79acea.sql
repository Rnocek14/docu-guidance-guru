UPDATE public.competitor_intel_profiles
SET fetch_strategy = 'browserless'
WHERE firm_id = 'bulenox';

UPDATE public.competitor_intel_profiles
SET urls = jsonb_build_object(
  'pricing', 'https://ftmo.com/en/2-step-challenge/',
  'rules', 'https://ftmo.com/en/1-step-challenge/'
)
WHERE firm_id = 'ftmo';