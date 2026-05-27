
UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://apextraderfunding.com/member/aff/go/lovable?i=21',
  'rules',   'https://apextraderfunding.com/rules'
) WHERE firm_id = 'apex';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://www.topstep.com/pricing-plans/',
  'rules',   'https://help.topstep.com/en/articles/9931344-trading-combine-rules'
) WHERE firm_id = 'topstep';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://ftmo.com/en/account-sizes/',
  'rules',   'https://ftmo.com/en/trading-objectives/'
) WHERE firm_id = 'ftmo';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://myfundedfutures.com/pricing/',
  'rules',   'https://myfundedfutures.com/faq/'
) WHERE firm_id = 'mffu';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://takeprofittrader.com/pricing',
  'rules',   'https://takeprofittrader.com/rules'
) WHERE firm_id = 'tpt';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://tradeify.co/funded-accounts/',
  'rules',   'https://tradeify.co/rules/'
) WHERE firm_id = 'tradeify';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://fundednext.com/futures/pricing',
  'rules',   'https://fundednext.com/futures/rules'
) WHERE firm_id = 'fundednext';

UPDATE public.competitor_intel_profiles SET urls = jsonb_build_object(
  'pricing', 'https://bulenox.com/pricing/',
  'rules',   'https://bulenox.com/rules/'
) WHERE firm_id = 'bulenox';
