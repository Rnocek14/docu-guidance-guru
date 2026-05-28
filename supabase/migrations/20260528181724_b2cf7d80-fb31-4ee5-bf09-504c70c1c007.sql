update public.competitor_intel_profiles
set urls = urls || jsonb_build_object('pricing', 'https://www.topstep.com/topstep-prop')
where firm_id = 'topstep';