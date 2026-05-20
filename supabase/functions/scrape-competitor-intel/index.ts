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
const OPENAI_MODEL = 'gpt-4o-mini'
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
type FetchStrategy = 'direct' | 'firecrawl'

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
    "consistency_rule_pct": number|null, "payout_cadence_days": number|null
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
    'list_price_usd is the crossed-out / original price. promo_price_usd is the discounted price actually charged today. ' +
    'If only one price is shown, put it in list_price_usd and leave promo_price_usd null. ' +
    'account_size_label is the marketed account size (e.g. "50K", "100K", "150K"). ' +
    'Do not include rules you cannot literally find on the page.'

  const userMsg = `${schemaDescription}\n\nSOURCE TEXT (truncated):\n${text.slice(0, 18000)}`

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
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
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    throw new Error('openai returned non-JSON')
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
async function firecrawlScrape(
  url: string,
  kind: ScrapeKind,
  apiKey: string,
): Promise<{ payload: Record<string, unknown>; markdown: string }> {
  const schema = kind === 'weekly' ? FULL_SCHEMA : PROMO_SCHEMA
  const res = await fetch(FIRECRAWL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', { type: 'json', schema }],
      onlyMainContent: true,
      waitFor: 1500,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`firecrawl ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const doc = data.data ?? data
  const payload = (doc.json ?? doc.extract ?? {}) as Record<string, unknown>
  const markdown = (doc.markdown ?? '') as string
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
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      changes.push({ field: f, old_value: ov ?? null, new_value: nv ?? null, severity: severityFor(f) })
    }
  }
  return changes
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
      const targetUrl = urls.pricing ?? urls.rules ?? urls.promo ?? ''
      const strategy: FetchStrategy =
        strategyOverride ?? ((p.fetch_strategy as FetchStrategy) || 'direct')
      if (!targetUrl) {
        results.push({ firm_id: firmId, status: 'skipped_no_url', changes: 0 })
        continue
      }

      try {
        let payload: Record<string, unknown>
        let markdown: string
        let usedStrategy: FetchStrategy = strategy
        if (strategy === 'firecrawl') {
          if (!firecrawlKey) throw new Error('firecrawl strategy selected but FIRECRAWL_API_KEY missing')
          ;({ payload, markdown } = await firecrawlScrape(targetUrl, kind, firecrawlKey))
        } else {
          if (!openaiKey) throw new Error('direct strategy selected but OPENAI_API_KEY missing')
          try {
            ;({ payload, markdown } = await directScrape(targetUrl, kind, openaiKey))
          } catch (directErr) {
            const directMsg = directErr instanceof Error ? directErr.message : 'unknown direct error'
            console.error(`direct failed for ${firmId}: ${directMsg}`)
            // Auto-fallback to Firecrawl if available — Cloudflare / JS-rendered sites
            if (firecrawlKey) {
              try {
                ;({ payload, markdown } = await firecrawlScrape(targetUrl, kind, firecrawlKey))
                usedStrategy = 'firecrawl'
              } catch (fcErr) {
                const fcMsg = fcErr instanceof Error ? fcErr.message : 'unknown firecrawl error'
                throw new Error(`direct: ${directMsg} | firecrawl: ${fcMsg}`)
              }
            } else {
              throw directErr
            }
          }
        }

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
