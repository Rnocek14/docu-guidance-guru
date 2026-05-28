
update public.competitor_intel_profiles
set urls = '{"pricing":"https://alpha-futures.com/#pricing","rules":"https://alpha-futures.com/"}'::jsonb
where firm_id = 'alpha';

update public.competitor_intel_profiles
set urls = '{"pricing":"https://halcyontraderfunding.com/","rules":"https://halcyontraderfunding.com/"}'::jsonb
where firm_id = 'halcyon';

update public.competitor_intel_profiles
set urls = '{"pricing":"https://lucidtrading.com/#plans","rules":"https://lucidtrading.com/"}'::jsonb
where firm_id = 'lucid';
