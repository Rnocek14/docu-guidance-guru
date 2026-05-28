update public.competitor_intel_profiles
set urls = jsonb_build_object(
  'pricing', 'https://halcyontraderfunding.kb.help/funded-accounts/',
  'rules',   'https://halcyontraderfunding.kb.help/'
)
where firm_id = 'halcyon';