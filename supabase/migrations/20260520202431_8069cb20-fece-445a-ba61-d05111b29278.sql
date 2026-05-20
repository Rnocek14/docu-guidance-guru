UPDATE public.competitor_intel_profiles
SET urls = jsonb_set(urls, '{pricing}', '"https://ftmo.com/en/account-sizes/"'),
    updated_at = now()
WHERE firm_id = 'ftmo';