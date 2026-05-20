ALTER TABLE public.competitor_intel_profiles
ADD COLUMN IF NOT EXISTS fetch_strategy TEXT NOT NULL DEFAULT 'direct';
-- 'direct' = fetch + OpenAI normalize (cheap, default)
-- 'firecrawl' = Firecrawl scrape (for Cloudflare/JS-rendered sites)
COMMENT ON COLUMN public.competitor_intel_profiles.fetch_strategy IS 'direct | firecrawl';