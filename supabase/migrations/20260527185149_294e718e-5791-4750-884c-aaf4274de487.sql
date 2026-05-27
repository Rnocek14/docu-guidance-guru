UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://www.topstep.com/","rules":"https://www.topstep.com/express-funded-account-rules"}'::jsonb WHERE firm_id='topstep';
UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://ftmo.com/en/","rules":"https://ftmo.com/en/"}'::jsonb WHERE firm_id='ftmo';
UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://myfundedfutures.com/","rules":"https://myfundedfutures.com/"}'::jsonb WHERE firm_id='mffu';
UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://takeprofittrader.com/","rules":"https://takeprofittrader.com/"}'::jsonb WHERE firm_id='tpt';
UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://tradeify.co/","rules":"https://tradeify.co/"}'::jsonb WHERE firm_id='tradeify';
UPDATE public.competitor_intel_profiles SET urls = '{"pricing":"https://apextraderfunding.com/","rules":"https://apextraderfunding.com/"}'::jsonb WHERE firm_id='apex';
-- Topstep, TPT, MFFU need JS rendering for pricing tables. Switch to browserless.
UPDATE public.competitor_intel_profiles SET fetch_strategy='browserless' WHERE firm_id IN ('topstep','tpt','mffu');
-- FTMO homepage renders pricing in plain HTML; revert to direct (browserless was overkill).
UPDATE public.competitor_intel_profiles SET fetch_strategy='direct' WHERE firm_id='ftmo';