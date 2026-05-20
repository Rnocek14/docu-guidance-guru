UPDATE public.competitor_intel_profiles
SET urls = jsonb_set(urls, '{pricing}', '"https://www.topstep.com/pricing/"'::jsonb)
WHERE firm_id = 'topstep';

UPDATE public.competitor_intel_profiles
SET urls = jsonb_set(urls, '{pricing}', '"https://ftmo.com/en/"'::jsonb)
WHERE firm_id = 'ftmo';

-- Apex is Cloudflare-walled; mark it firecrawl-only so direct fetch isn't attempted
UPDATE public.competitor_intel_profiles
SET fetch_strategy = 'firecrawl'
WHERE firm_id = 'apex';