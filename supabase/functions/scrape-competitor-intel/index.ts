import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { constantTimeEqual } from '../_shared/crypto.ts'

/**
 * scrape-competitor-intel
 *
 * Scrapes competitor landing pages via Firecrawl, normalizes the response
 * into a stable schema, stores a snapshot, and diffs vs the most recent
 * snapshot of the same kind to produce change rows.
 *
 * STRICT BOUNDARY: nothing here is allowed to feed treasury / Monte Carlo /
 * pricing modules. This is observational intelligence only.
 *
 * Modes:
 *   kind=weekly     — pricing + rules + features (full snapshot)
 *   kind=promo_daily — pricing / promo only (cheap daily run)
 *
 * AUTH: admin JWT or X-Cron-Secret.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o'
// build: 2026-05-20-direct-2

// Browser-like UA so most landing pages return real HTML rather than a stub.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ────────────────────────────────────────────────────────────────────────────
// Extraction schemas — keep tight so diffs are semantic, not textual
// ────────────────────────────────────────────────────────────────────────────
const PROMO_SCHEMA = {
  type: 'object',
  properties: {
    pricing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          account_size_label: { type: 'string' },
          list_price_usd: { type: ['number', 'null'] },
          promo_price_usd: { type: ['number', 'null'] },
          promo_label: { type: ['string', 'null'] },
          discount_pct: { type: ['number', 'null'] },
        },
      },
    },
    active_promo_banner: { type: ['string', 'null'] },
    promo_code: { type: ['string', 'null'] },
  },
}

const FULL_SCHEMA = {
  type: 'object',
  properties: {
    pricing: PROMO_SCHEMA.properties.pricing,
    active_promo_banner: { type: ['string', 'null'] },
    promo_code: { type: ['string', 'null'] },
    rules: {
      type: 'object',
      properties: {
        profit_target_usd: { type: ['number', 'null'] },
        daily_loss_usd: { type: ['number', 'null'] },
        max_drawdown_usd: { type: ['number', 'null'] },
        drawdown_type: { type: ['string', 'null'] }, // 'static' | 'trailing' | 'eod_trailing'
        payout_split_pct: { type: ['number', 'null'] },
        first_payout_cap_usd: { type: ['number', 'null'] },
        first_payout_cap_count: { type: ['number', 'null'] },
        min_trading_days: { type: ['number', 'null'] },
        consistency_rule_pct: { type: ['number', 'null'] },
        payout_cadence_days: { type: ['number', 'null'] },
        reset_fee_usd: { type: ['number', 'null'] },
        activation_fee_usd: { type: ['number', 'null'] },
        activation_fee_cadence: { type: ['string', 'null'] }, // 'one_time' | 'monthly'
        phase_count: { type: ['number', 'null'] }, // 1 = instant/eval-only, 2 = eval+verification
        accounts_allowed_max: { type: ['number', 'null'] },
        trailing_dd_lock_usd: { type: ['number', 'null'] }, // profit point where trailing DD stops trailing
        news_trading_allowed: { type: ['boolean', 'null'] },
        payout_methods: { type: ['string', 'null'] }, // free-text e.g. "ACH, wire, crypto"
        scaling_plan_summary: { type: ['string', 'null'] }, // one-line description
      },
    },
    features: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Keywords like 'instant_funding', 'static_dd', 'copy_trading', 'mobile_app', 'leaderboard', 'crypto', 'scaling_plan'",
    },
  },
}

type ScrapeKind = 'weekly' | 'promo_daily'
type FetchStrategy = 'direct' | 'firecrawl' | 'browserless'

// ────────────────────────────────────────────────────────────────────────────
// Direct fetch + OpenAI normalization (default path, no Firecrawl credits)
// ────────────────────────────────────────────────────────────────────────────
function htmlToText(html: string): string {
  // Strip scripts/styles, then tags. Crude but good enough for an LLM input.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function directFetch(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function browserlessFetch(url: string, apiKey: string): Promise<string> {
  // Try the standard /content endpoint first. If the response is thin
 // (Cloudflare interstitial), fall back to the /unblock endpoint which
 // solves bot-detection challenges (Apex, some FTMO pages).
  const baseHost = 'https://production-sfo.browserless.io'
  // Browserless free/starter plans cap timeout at 60,000ms; values above return 400.
  const tryEndpoint = async (path: string, body: Record<string, unknown>, timeoutMs = 60_000): Promise<string> => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs + 10_000)
    try {
      // Browserless accepts ?timeout=<ms> to extend its internal 30s default.
      const res = await fetch(`${baseHost}${path}?token=${apiKey}&timeout=${timeoutMs}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`browserless ${path} ${res.status}: ${txt.slice(0, 200)}`)
      }
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        const j = await res.json()
        return (j?.content ?? j?.html ?? '') as string
      }
      return await res.text()
    } finally {
      clearTimeout(t)
    }
  }

  let html = await tryEndpoint('/content', {
    url,
    gotoOptions: { waitUntil: 'domcontentloaded', timeout: 45_000 },
    bestAttempt: true,
  }, 55_000)
  // If suspiciously thin (Cloudflare interstitial, JS gate), retry with /unblock.
  const looksBlocked =
    html.length < 4_000 ||
    /just a moment|cf-chl|challenge-platform|attention required|sorry, you have been blocked|cloudflare/i.test(html)
  if (looksBlocked) {
    try {
      // Browserless v2 unblock endpoint (Chrome). Returns JSON { content, ... }.
      const unblocked = await tryEndpoint('/chrome/unblock', {
        url,
        browserWSEndpoint: false,
        content: true,
        cookies: false,
        screenshot: false,
        ttl: 0,
      }, 60_000)
      if (unblocked && unblocked.length > html.length) html = unblocked
    } catch (e) {
      // /unblock can 402 on free plans — keep the thin content rather than fail.
      console.warn('browserless /unblock fallback failed:', e instanceof Error ? e.message : e)
    }
  }
  return html
}

function looksLikeBlockedContent(text: string): boolean {
  return /attention required|sorry, you have been blocked|cloudflare ray id|please enable cookies|just a moment|cf-chl|challenge-platform/i.test(text)
}

function isWeakPricing(payload: Record<string, unknown>): boolean {
  const rows = payload.pricing
  if (!Array.isArray(rows) || rows.length === 0) return true
  return rows.every((r) => {
    if (!r || typeof r !== 'object') return true
    const row = r as Record<string, unknown>
    return row.account_size_label == null && row.list_price_usd == null && row.promo_price_usd == null
  })
}

const CURATED_REFERENCE: Record<string, Record<string, unknown>> = {
  apex: {
    pricing: [
      { account_size_label: '25K',  list_price_usd: 167, promo_price_usd: 16.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '50K',  list_price_usd: 187, promo_price_usd: 18.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '75K',  list_price_usd: 207, promo_price_usd: 20.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '100K', list_price_usd: 297, promo_price_usd: 29.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '150K', list_price_usd: 297, promo_price_usd: 29.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '250K', list_price_usd: 517, promo_price_usd: 51.70,  promo_label: 'SAVENOW', discount_pct: 90 },
      { account_size_label: '300K', list_price_usd: 657, promo_price_usd: 65.70,  promo_label: 'SAVENOW', discount_pct: 90 },
    ],
    active_promo_banner: 'Any Size Evals up to 90% Off — use code SAVENOW',
    promo_code: 'SAVENOW',
    rules: {
      profit_target_usd: 1500,
      daily_loss_usd: null,
      max_drawdown_usd: 1000,
      drawdown_type: 'trailing',
      payout_split_pct: 100,
      first_payout_cap_usd: 25000,
      first_payout_cap_count: 5,
      min_trading_days: 1,
      consistency_rule_pct: 50,
      payout_cadence_days: 5,
      reset_fee_usd: 80,
      activation_fee_usd: 130,
      activation_fee_cadence: 'monthly',
      phase_count: 1,
      accounts_allowed_max: 20,
      trailing_dd_lock_usd: null,
      news_trading_allowed: true,
      payout_methods: 'WISE, Plane, ACH',
      scaling_plan_summary: 'Contract scaling tied to balance milestones',
    },
    features: ['scaling_plan', 'one_time_fee', 'fast_payouts'],
  },
  bulenox: {
    rules: {
      profit_target_usd: 3000,
      daily_loss_usd: null,
      max_drawdown_usd: 2500,
      drawdown_type: 'eod_trailing',
      first_payout_cap_count: 5,
      min_trading_days: 7,
      consistency_rule_pct: 30,
      payout_cadence_days: 14,
      activation_fee_usd: 148,
      activation_fee_cadence: 'monthly',
      phase_count: 1,
      accounts_allowed_max: 5,
      news_trading_allowed: true,
      scaling_plan_summary: 'Contract scaling tied to profit milestones',
    },
    features: ['eod_trailing', 'scaling_plan', 'reset_discount'],
  },
  ftmo: {
    pricing: [
      { account_size_label: '10K',  list_price_usd: 89,  promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '25K',  list_price_usd: 155, promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '50K',  list_price_usd: 250, promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '100K', list_price_usd: 345, promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '200K', list_price_usd: 540, promo_price_usd: null, promo_label: null, discount_pct: null },
    ],
    rules: {
      profit_target_usd: 10000,            // 10% of 100K Challenge
      daily_loss_usd: 5000,                // 5% daily loss
      max_drawdown_usd: 10000,             // 10% max loss
      drawdown_type: 'static',
      payout_split_pct: 80,
      first_payout_cap_usd: null,
      first_payout_cap_count: null,
      min_trading_days: 4,
      consistency_rule_pct: null,
      payout_cadence_days: 14,
      activation_fee_usd: 0,
      phase_count: 2,
      news_trading_allowed: true,
      payout_methods: 'Wire, crypto, Skrill',
    },
    features: ['two_phase_eval', 'static_drawdown', 'biweekly_payouts'],
  },
  fundednext: {
    pricing: [
      { account_size_label: '25K',  list_price_usd: 142, promo_price_usd: 106.50, promo_label: 'EIDFNC', discount_pct: 25 },
      { account_size_label: '50K',  list_price_usd: 269, promo_price_usd: 201.75, promo_label: 'EIDFNC', discount_pct: 25 },
      { account_size_label: '100K', list_price_usd: 469, promo_price_usd: 351.75, promo_label: 'EIDFNC', discount_pct: 25 },
      { account_size_label: '150K', list_price_usd: 599, promo_price_usd: 449.25, promo_label: 'EIDFNC', discount_pct: 25 },
      { account_size_label: '250K', list_price_usd: 899, promo_price_usd: 674.25, promo_label: 'EIDFNC', discount_pct: 25 },
      { account_size_label: '300K', list_price_usd: 999, promo_price_usd: 749.25, promo_label: 'EIDFNC', discount_pct: 25 },
    ],
    active_promo_banner: 'Up to 25% Off on all Stellar Plans',
    promo_code: 'EIDFNC',
    rules: {
      profit_target_usd: 8000,             // 8% Phase 1 / 5% Phase 2 of 100K
      daily_loss_usd: 5000,                // 5% daily
      max_drawdown_usd: 10000,             // 10% max
      drawdown_type: 'static',
      payout_split_pct: 95,
      first_payout_cap_usd: null,
      first_payout_cap_count: null,
      min_trading_days: 5,
      consistency_rule_pct: null,
      payout_cadence_days: 21,
      activation_fee_usd: 0,
      phase_count: 2,
      news_trading_allowed: true,
      payout_methods: 'Wire, crypto',
    },
    features: ['stellar_plan', 'scaling_plan', 'static_drawdown'],
  },
  topstep: {
    pricing: [
      { account_size_label: '50K',  list_price_usd: 49,  promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '100K', list_price_usd: 99,  promo_price_usd: null, promo_label: null, discount_pct: null },
      { account_size_label: '150K', list_price_usd: 149, promo_price_usd: null, promo_label: null, discount_pct: null },
    ],
    rules: {
      profit_target_usd: 6000,             // 100K Combine
      daily_loss_usd: null,                // trailing only, no daily loss
      max_drawdown_usd: 3000,              // 100K trailing
      drawdown_type: 'eod_trailing',
      payout_split_pct: 90,
      first_payout_cap_usd: 5000,
      first_payout_cap_count: 5,
      min_trading_days: 2,
      consistency_rule_pct: 50,
      payout_cadence_days: 7,
      reset_fee_usd: 49,
      activation_fee_usd: 149,
      activation_fee_cadence: 'one_time',
      phase_count: 1,
      accounts_allowed_max: 5,
      trailing_dd_lock_usd: 0,
      news_trading_allowed: true,
      payout_methods: 'ACH, wire',
      scaling_plan_summary: 'Express Funded after Combine pass',
    },
    features: ['trading_combine', 'express_funded', 'scaling_plan'],
  },
  tradeify: {
    pricing: [
      { account_size_label: '25K',  list_price_usd: 121, promo_price_usd: 72.60,  promo_label: 'MAY', discount_pct: 40 },
      { account_size_label: '50K',  list_price_usd: 141, promo_price_usd: 84.60,  promo_label: 'MAY', discount_pct: 40 },
      { account_size_label: '75K',  list_price_usd: 161, promo_price_usd: 96.60,  promo_label: 'MAY', discount_pct: 40 },
      { account_size_label: '100K', list_price_usd: 181, promo_price_usd: 108.60, promo_label: 'MAY', discount_pct: 40 },
      { account_size_label: '150K', list_price_usd: 251, promo_price_usd: 150.60, promo_label: 'MAY', discount_pct: 40 },
    ],
    rules: {
      profit_target_usd: 9000,             // 150K Advanced
      daily_loss_usd: null,
      max_drawdown_usd: 4500,
      drawdown_type: 'eod_trailing',
      payout_split_pct: 90,
      first_payout_cap_usd: 1250,
      first_payout_cap_count: 3,
      min_trading_days: 5,
      consistency_rule_pct: 35,
      payout_cadence_days: 1,
      phase_count: 1,
      news_trading_allowed: true,
      scaling_plan_summary: 'Straight-to-sim funded after eval',
    },
    features: ['straight_to_sim', 'eod_trailing', 'fast_payouts'],
  },
  mffu: {
    pricing: [
      { account_size_label: '25K', list_price_usd: 153, promo_price_usd: 92, promo_label: '40% off', discount_pct: 40 },
      { account_size_label: '50K', list_price_usd: 153, promo_price_usd: 92, promo_label: '40% off', discount_pct: 40 },
      { account_size_label: '100K', list_price_usd: 157, promo_price_usd: 126, promo_label: '40% off', discount_pct: 20 },
      { account_size_label: '150K', list_price_usd: 227, promo_price_usd: 114, promo_label: '40% off', discount_pct: 50 },
    ],
    rules: {
      profit_target_usd: 3000,
      max_drawdown_usd: 2000,
      drawdown_type: 'eod_trailing',
      first_payout_cap_usd: 7500,
      first_payout_cap_count: 3,
      phase_count: 1,
      news_trading_allowed: true,
    },
  },
  tpt: {
    pricing: [
      { account_size_label: '25K', list_price_usd: 150, promo_price_usd: 105, promo_label: 'NOFEE30', discount_pct: 30 },
      { account_size_label: '50K', list_price_usd: 170, promo_price_usd: 119, promo_label: 'NOFEE30', discount_pct: 30 },
      { account_size_label: '75K', list_price_usd: 245, promo_price_usd: 171.5, promo_label: 'NOFEE30', discount_pct: 30 },
      { account_size_label: '100K', list_price_usd: 330, promo_price_usd: 231, promo_label: 'NOFEE30', discount_pct: 30 },
      { account_size_label: '150K', list_price_usd: 360, promo_price_usd: 252, promo_label: 'NOFEE30', discount_pct: 30 },
    ],
    rules: {
      profit_target_usd: 3000,
      daily_loss_usd: 1100,
      max_drawdown_usd: 2000,
      drawdown_type: 'eod_trailing',
      first_payout_cap_usd: 1500,
      first_payout_cap_count: 1,
      phase_count: 1,
      news_trading_allowed: true,
    },
  },
}

function applyCuratedReference(firmId: string, payload: Record<string, unknown>): void {
  const fallback = CURATED_REFERENCE[firmId]
  if (!fallback) return
  const filledFields: string[] = []
  // Snapshot what the scraper actually produced BEFORE we merge anything.
  const scrapedPricing = Array.isArray(payload.pricing) ? (payload.pricing as Record<string, unknown>[]) : []
  const scrapedRules = (payload.rules && typeof payload.rules === 'object'
    ? payload.rules
    : {}) as Record<string, unknown>
  const scraperHadPricing = scrapedPricing.some(
    (r) => r && typeof r === 'object' && (r.list_price_usd != null || r.promo_price_usd != null),
  )
  const scraperHadRules = Object.values(scrapedRules).some((v) => v != null)

  if (Array.isArray(fallback.pricing)) {
    const scraped = scrapedPricing
    const normLabel = (l: unknown) => String(l ?? '').toUpperCase().replace(/[^0-9K]/g, '')
    const seen = new Set(
      scraped
        .filter((r) => r && typeof r === 'object' && r.account_size_label != null)
        .map((r) => normLabel(r.account_size_label)),
    )
    const merged = [...scraped]
    for (const row of fallback.pricing as Record<string, unknown>[]) {
      if (!seen.has(normLabel(row.account_size_label))) {
        merged.push(row)
        filledFields.push(`pricing[${row.account_size_label}]`)
      }
    }
    // Sort by numeric account size for stable display
    merged.sort((a, b) => {
      const av = parseInt(normLabel((a as Record<string, unknown>).account_size_label)) || 0
      const bv = parseInt(normLabel((b as Record<string, unknown>).account_size_label)) || 0
      return av - bv
    })
    payload.pricing = merged
  }
  const rules = (payload.rules && typeof payload.rules === 'object' ? payload.rules : {}) as Record<string, unknown>
  const fallbackRules = (fallback.rules && typeof fallback.rules === 'object' ? fallback.rules : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(fallbackRules)) {
    if (rules[key] == null && value != null) {
      rules[key] = value
      filledFields.push(`rules.${key}`)
    }
  }
  payload.rules = rules
  for (const key of ['active_promo_banner', 'promo_code', 'features']) {
    if ((payload[key] == null || (Array.isArray(payload[key]) && (payload[key] as unknown[]).length === 0)) && fallback[key] != null) {
      payload[key] = fallback[key]
      filledFields.push(key)
    }
  }
  if (filledFields.length === 0) return
  // If the scraper produced neither real pricing nor any rules, the entire
  // record is reference data — flag it as fully unverified so the strict
  // comparison filter drops it. Otherwise it's a partial gap-fill on top of
  // a real scrape; record which fields were merged but keep it verifiable.
  if (!scraperHadPricing && !scraperHadRules) {
    payload._fallback_used = 'curated_reference'
  } else {
    payload._fallback_used = 'partial'
  }
  payload._fallback_fields = filledFields
}

async function openaiNormalize(
  text: string,
  kind: ScrapeKind,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const schemaDescription =
    kind === 'weekly'
      ? `Return JSON with this exact shape:
{
  "pricing": [ { "account_size_label": string, "list_price_usd": number|null, "promo_price_usd": number|null, "promo_label": string|null, "discount_pct": number|null } ],
  "active_promo_banner": string|null,
  "promo_code": string|null,
  "rules": {
    "profit_target_usd": number|null, "daily_loss_usd": number|null,
    "max_drawdown_usd": number|null, "drawdown_type": "static"|"trailing"|"eod_trailing"|null,
    "payout_split_pct": number|null, "first_payout_cap_usd": number|null,
    "first_payout_cap_count": number|null, "min_trading_days": number|null,
    "consistency_rule_pct": number|null, "payout_cadence_days": number|null,
    "reset_fee_usd": number|null, "activation_fee_usd": number|null,
    "activation_fee_cadence": "one_time"|"monthly"|null,
    "phase_count": number|null, "accounts_allowed_max": number|null,
    "trailing_dd_lock_usd": number|null, "news_trading_allowed": boolean|null,
    "payout_methods": string|null, "scaling_plan_summary": string|null
  },
  "features": [string]
}`
      : `Return JSON with this exact shape:
{
  "pricing": [ { "account_size_label": string, "list_price_usd": number|null, "promo_price_usd": number|null, "promo_label": string|null, "discount_pct": number|null } ],
  "active_promo_banner": string|null,
  "promo_code": string|null
}`

  const system =
    'You normalize prop-firm landing pages into strict JSON. Never invent values. ' +
    'If a field is not explicitly present in the source, use null. ' +
    'The input may concatenate multiple pages (pricing + rules + promo). Read ALL of them before answering. ' +
    'list_price_usd is the crossed-out / original price. promo_price_usd is the discounted price actually charged today. ' +
    'If only one price is shown, put it in list_price_usd and leave promo_price_usd null. ' +
    'account_size_label is the marketed account size (e.g. "50K", "100K", "150K"). ' +
    'For rules: extract profit target, daily loss limit, max drawdown (USD), drawdown type ' +
    '(static / trailing / eod_trailing), payout split %, first payout cap (USD and count), ' +
    'minimum trading days, consistency rule %, and payout cadence in days. Convert phrases like ' +
    '"every 14 days" to 14, "weekly" to 7, "daily" to 1. ' +
    'Also extract: reset fee (USD to retake a failed evaluation), activation fee (USD + whether one_time or monthly), ' +
    'phase_count (1 for instant/eval-only, 2 for eval+verification), accounts_allowed_max (max concurrent accounts), ' +
    'trailing_dd_lock_usd (profit point where trailing drawdown stops trailing), news_trading_allowed (true/false), ' +
    'payout_methods (short string like "ACH, wire, crypto"), scaling_plan_summary (one short sentence if mentioned). ' +
    'For features: short keyword tags only (e.g. "instant_funding", "static_dd", "scaling_plan"). ' +
    'Do not include rules you cannot literally find in the source text.'

  const userMsg = `${schemaDescription}\n\nSOURCE TEXT (truncated):\n${text.slice(0, 40000)}`

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`openai ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content ?? '{}'
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    derivePricing(parsed)
    return parsed
  } catch {
    throw new Error('openai returned non-JSON')
  }
}

/**
 * Fill in promo_price_usd / list_price_usd / discount_pct when two of the
 * three are present. Models often extract list + discount but skip the
 * arithmetic for promo, leaving the UI showing "—" in the Promo column.
 */
function derivePricing(payload: Record<string, unknown>): void {
  const rows = payload.pricing
  if (!Array.isArray(rows)) return
  for (const r of rows as Array<Record<string, unknown>>) {
    const list = typeof r.list_price_usd === 'number' ? r.list_price_usd : null
    const promo = typeof r.promo_price_usd === 'number' ? r.promo_price_usd : null
    const disc = typeof r.discount_pct === 'number' ? r.discount_pct : null

    if (list != null && disc != null && promo == null && disc > 0 && disc < 100) {
      r.promo_price_usd = Math.round(list * (1 - disc / 100) * 100) / 100
    } else if (list != null && promo != null && disc == null && list > 0 && promo < list) {
      r.discount_pct = Math.round(((list - promo) / list) * 10000) / 100
    } else if (promo != null && disc != null && list == null && disc > 0 && disc < 100) {
      r.list_price_usd = Math.round((promo / (1 - disc / 100)) * 100) / 100
    }
  }
}

async function directScrape(
  url: string,
  kind: ScrapeKind,
  openaiKey: string,
): Promise<{ payload: Record<string, unknown>; markdown: string }> {
  const html = await directFetch(url)
  const text = htmlToText(html)
  if (text.length < 200) {
    throw new Error(`direct fetch returned too little content (${text.length} chars) — site likely JS-rendered or bot-walled`)
  }
  const payload = await openaiNormalize(text, kind, openaiKey)
  return { payload, markdown: text.slice(0, 20000) }
}

// ────────────────────────────────────────────────────────────────────────────
// Firecrawl call
// ────────────────────────────────────────────────────────────────────────────
async function firecrawlMarkdown(url: string, apiKey: string): Promise<string> {
  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: 6000,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`firecrawl ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const doc = data.data ?? data
  const md = (doc.markdown ?? '') as string
  if (!md || md.length < 200) {
    throw new Error(`firecrawl returned too little markdown (${md.length} chars)`)
  }
  return md
}

/**
 * When a site advertises a single global discount in the banner (e.g.
 * "40% off all accounts") but the model didn't put discount_pct on each
 * pricing row, propagate it to rows that have a list price but no discount.
 */
function applyBannerDiscountToRows(payload: Record<string, unknown>): void {
  const rows = payload.pricing
  const banner = (payload.active_promo_banner as string | null) ?? ''
  if (!Array.isArray(rows) || !banner) return
  const m = banner.match(/(\d{1,2}(?:\.\d+)?)\s*%\s*off/i)
  if (!m) return
  const pct = Number.parseFloat(m[1])
  if (!(pct > 0 && pct < 100)) return
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r.discount_pct == null && typeof r.list_price_usd === 'number') {
      r.discount_pct = pct
    }
  }
}

async function firecrawlScrape(
  url: string,
  kind: ScrapeKind,
  apiKey: string,
  openaiKey: string,
): Promise<{ payload: Record<string, unknown>; markdown: string }> {
  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: 6000,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`firecrawl ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const doc = data.data ?? data
  const markdown = (doc.markdown ?? '') as string
  if (!markdown || markdown.length < 200) {
    throw new Error(`firecrawl returned too little markdown (${markdown.length} chars)`)
  }
  if (!openaiKey) throw new Error('OPENAI_API_KEY required to normalize firecrawl markdown')
  // Reuse the same OpenAI normalizer as the direct path — much more reliable
  // than Firecrawl's own JSON-schema extractor on heavy landing pages.
  const payload = await openaiNormalize(markdown, kind, openaiKey)
  return { payload, markdown: markdown.slice(0, 20000) }
}

// ────────────────────────────────────────────────────────────────────────────
// Diff — semantic, on the normalized payload
// ────────────────────────────────────────────────────────────────────────────
type JsonVal = unknown

function flatten(obj: JsonVal, prefix = ''): Record<string, JsonVal> {
  const out: Record<string, JsonVal> = {}
  if (obj === null || obj === undefined) return out
  if (Array.isArray(obj)) {
    // For arrays, keep the whole array as a single value (e.g., pricing rows)
    out[prefix || 'value'] = obj
    return out
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, JsonVal>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flatten(v, key))
      } else {
        out[key] = v
      }
    }
    return out
  }
  out[prefix || 'value'] = obj
  return out
}

function severityFor(field: string): 'low' | 'medium' | 'high' {
  if (
    field.includes('payout_split_pct') ||
    field.includes('first_payout_cap') ||
    field.includes('drawdown_type') ||
    field === 'pricing'
  ) return 'high'
  if (
    field.includes('promo') ||
    field.includes('discount_pct') ||
    field.includes('payout_cadence_days') ||
    field.includes('consistency_rule_pct')
  ) return 'medium'
  return 'low'
}

function diff(oldPayload: JsonVal, newPayload: JsonVal): Array<{
  field: string
  old_value: JsonVal
  new_value: JsonVal
  severity: 'low' | 'medium' | 'high'
}> {
  const o = flatten(oldPayload ?? {})
  const n = flatten(newPayload ?? {})
  const fields = new Set([...Object.keys(o), ...Object.keys(n)])
  const changes: Array<{ field: string; old_value: JsonVal; new_value: JsonVal; severity: 'low' | 'medium' | 'high' }> = []
  for (const f of fields) {
    // Skip internal/meta fields (prefixed with _) so strategy flips aren't noise
    if (f.startsWith('_') || f.includes('._')) continue
    const ov = o[f]
    const nv = n[f]
    if (stableStringify(ov) !== stableStringify(nv)) {
      changes.push({ field: f, old_value: ov ?? null, new_value: nv ?? null, severity: severityFor(f) })
    }
  }
  return changes
}

function stableStringify(value: JsonVal): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, JsonVal>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

// ────────────────────────────────────────────────────────────────────────────
// Auth gate
// ────────────────────────────────────────────────────────────────────────────
async function isAuthorized(req: Request, db: ReturnType<typeof createClient>, cronSecret: string): Promise<boolean> {
  const incomingCron = (req.headers.get('X-Cron-Secret') ?? '').trim()
  if (cronSecret && cronSecret.length >= 16 && incomingCron) {
    if (await constantTimeEqual(incomingCron, cronSecret)) return true
  }
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return false
  const jwt = authHeader.replace('Bearer ', '')
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
  )
  const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(jwt)
  if (claimsErr || !claimsData?.claims?.sub) {
    console.warn('auth: getClaims failed', claimsErr?.message)
    return false
  }
  const userId = claimsData.claims.sub
  const { data: hasAdmin, error: rpcErr } = await db.rpc('has_role', { _user_id: userId, _role: 'admin' })
  if (rpcErr) console.warn('auth: has_role rpc failed', rpcErr.message)
  return hasAdmin === true
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const dbgAuth = req.headers.get('Authorization') ?? ''
    const dbgCron = req.headers.get('X-Cron-Secret') ?? ''
    console.log('DBG req', {
      hasAuth: dbgAuth.length > 0,
      authPrefix: dbgAuth.slice(0, 24),
      hasCron: dbgCron.length > 0,
      method: req.method,
    })
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY') ?? ''
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
    let browserlessKey = Deno.env.get('BROWSERLESS_API_KEY') ?? ''
    if (!browserlessKey) {
      const { data: bls } = await createClient(supabaseUrl, serviceKey)
        .from('system_settings')
        .select('value')
        .eq('key', 'browserless_api_key')
        .single()
      browserlessKey = (bls?.value as { key?: string } | undefined)?.key ?? ''
    }
    if (!openaiKey && !firecrawlKey) {
      return new Response(
        JSON.stringify({ error: 'Need either OPENAI_API_KEY or FIRECRAWL_API_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const db = createClient(supabaseUrl, serviceKey)

    // Resolve cron secret
    let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    if (!cronSecret || cronSecret.length < 16) {
      const { data } = await db.from('internal_secrets').select('value').eq('key', 'CRON_SECRET').single()
      cronSecret = (data?.value as string) ?? ''
    }

    if (!(await isAuthorized(req, db, cronSecret))) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Parse params
    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const kind: ScrapeKind = (body.kind ?? url.searchParams.get('kind') ?? 'weekly') as ScrapeKind
    const firmFilter: string | null = body.firm_id ?? url.searchParams.get('firm_id') ?? null

    if (kind !== 'weekly' && kind !== 'promo_daily') {
      return new Response(JSON.stringify({ error: 'Invalid kind' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Optional override: ?strategy=direct|firecrawl forces a single strategy for this run
    const strategyOverride = (body.strategy ?? url.searchParams.get('strategy') ?? null) as FetchStrategy | null

    // Fetch active profiles
    let q = db
      .from('competitor_intel_profiles')
      .select('firm_id, urls, fetch_strategy')
      .eq('active', true)
    if (firmFilter) q = q.eq('firm_id', firmFilter)
    const { data: profiles, error: profilesErr } = await q
    if (profilesErr) throw profilesErr

    const results: Array<{ firm_id: string; status: string; changes: number; error?: string }> = []

    for (const p of profiles ?? []) {
      const firmId = p.firm_id as string
      const urls = (p.urls ?? {}) as Record<string, string>
      // Scrape ALL configured URLs (pricing + rules + promo) and merge their
      // markdown so the extractor sees facts spread across multiple pages.
      const urlList = [urls.pricing, urls.rules, urls.promo].filter(
        (u, i, a) => !!u && a.indexOf(u) === i,
      ) as string[]
      const targetUrl = urlList[0] ?? ''
      const strategy: FetchStrategy =
        strategyOverride ?? ((p.fetch_strategy as FetchStrategy) || 'direct')
      if (!targetUrl) {
        results.push({ firm_id: firmId, status: 'skipped_no_url', changes: 0 })
        continue
      }

      try {
        let payload: Record<string, unknown> = {}
        let markdown: string = ''
        let usedStrategy: FetchStrategy = strategy

        // Pull raw markdown from every configured URL (don't normalize each
        // one in isolation — concatenate first, then run a single extraction
        // pass so the model can correlate pricing on one page with rules on
        // another).
        const chunks: string[] = []
        const errs: string[] = []
        for (const u of urlList) {
          try {
            let md = ''
            if (strategy === 'firecrawl') {
              if (!firecrawlKey) throw new Error('FIRECRAWL_API_KEY missing')
              try {
                md = await firecrawlMarkdown(u, firecrawlKey)
              } catch (fcErr) {
                if (browserlessKey) {
                  md = htmlToText(await browserlessFetch(u, browserlessKey))
                  usedStrategy = 'browserless'
                } else {
                  throw fcErr
                }
              }
            } else if (strategy === 'browserless') {
              if (!browserlessKey) throw new Error('BROWSERLESS_API_KEY missing')
              md = htmlToText(await browserlessFetch(u, browserlessKey))
              if (md.length < 400) throw new Error(`thin browserless content (${md.length})`)
            } else {
              try {
                md = htmlToText(await directFetch(u))
                if (md.length < 400) throw new Error(`thin html (${md.length})`)
              } catch (directErr) {
                const dmsg = directErr instanceof Error ? directErr.message : 'direct err'
                if (firecrawlKey) {
                  md = await firecrawlMarkdown(u, firecrawlKey)
                  usedStrategy = 'firecrawl'
                } else if (browserlessKey) {
                  md = htmlToText(await browserlessFetch(u, browserlessKey))
                  usedStrategy = 'browserless'
                } else {
                  throw new Error(dmsg)
                }
              }
            }
            chunks.push(`\n\n=== SOURCE: ${u} ===\n${md}`)
          } catch (e) {
            errs.push(`${u}: ${e instanceof Error ? e.message : 'err'}`)
          }
        }
        if (chunks.length === 0) {
          throw new Error(`all URLs failed — ${errs.join(' | ')}`)
        }
        markdown = chunks.join('\n').slice(0, 60_000)
        if (!openaiKey) throw new Error('OPENAI_API_KEY missing')
        payload = await openaiNormalize(markdown, kind, openaiKey)
        applyBannerDiscountToRows(payload)
        derivePricing(payload)
        applyCuratedReference(firmId, payload)
        markdown = markdown.slice(0, 20_000)

        // Find previous snapshot of same kind
        const { data: prev } = await db
          .from('competitor_intel_snapshots')
          .select('payload')
          .eq('firm_id', firmId)
          .eq('scrape_kind', kind)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // Insert new snapshot
        const { data: snap, error: snapErr } = await db
          .from('competitor_intel_snapshots')
          .insert({
            firm_id: firmId,
            scrape_kind: kind,
            source_url: targetUrl,
            payload: { ...payload, _fetch_strategy: usedStrategy },
            raw_markdown: markdown,
            extraction_confidence: payload && Object.keys(payload).length > 0 ? 'medium' : 'low',
          })
          .select('id')
          .single()
        if (snapErr) throw snapErr

        // Diff (only if we have a previous snapshot — first snapshot creates no change rows)
        let changeCount = 0
        if (prev?.payload) {
          const changes = diff(prev.payload, payload)
          if (changes.length) {
            const rows = changes.map((c) => ({
              firm_id: firmId,
              snapshot_id: snap!.id,
              field: c.field,
              old_value: c.old_value,
              new_value: c.new_value,
              severity: c.severity,
            }))
            const { error: chErr } = await db.from('competitor_intel_changes').insert(rows)
            if (chErr) throw chErr
            changeCount = rows.length
          }
        }

        results.push({ firm_id: firmId, status: 'ok', changes: changeCount })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown'
        console.error(`scrape failed for ${firmId}:`, msg)
        results.push({ firm_id: firmId, status: 'error', changes: 0, error: msg })
      }
    }

    return new Response(JSON.stringify({ ok: true, kind, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('scrape-competitor-intel fatal:', e)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
