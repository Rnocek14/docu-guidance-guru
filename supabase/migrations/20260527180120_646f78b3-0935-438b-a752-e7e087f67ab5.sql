UPDATE public.competitor_intel_profiles
SET urls = jsonb_build_object('pricing', 'https://www.topstep.com/'),
    fetch_strategy = 'firecrawl'
WHERE firm_id = 'topstep';