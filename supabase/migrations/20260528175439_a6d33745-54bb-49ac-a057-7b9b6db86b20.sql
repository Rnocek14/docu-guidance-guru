
insert into public.competitor_intel_profiles (firm_id, name, active, kind, fetch_strategy, urls, notes)
values
  ('alpha', 'Alpha Futures', true, 'reference', 'browserless',
   '{"pricing":"https://alphafutures.com/","rules":"https://alphafutures.com/"}'::jsonb,
   'Newer futures entrant; verify rules each scrape.'),
  ('halcyon', 'Halcyon', true, 'reference', 'browserless',
   '{"pricing":"https://www.tradehalcyon.com/","rules":"https://www.tradehalcyon.com/"}'::jsonb,
   'Boutique futures firm; low data on funded-trader experience.'),
  ('lucid', 'Lucid Trading', true, 'reference', 'browserless',
   '{"pricing":"https://lucidtrading.com/","rules":"https://lucidtrading.com/"}'::jsonb,
   'Verify product line — historically multiple eval variants.')
on conflict (firm_id) do update set
  name = excluded.name,
  active = true,
  urls = excluded.urls,
  notes = excluded.notes;
