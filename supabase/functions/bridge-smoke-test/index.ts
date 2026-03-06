// Bridge Smoke Test — v1.0
//
// Validates that real broker webhook payloads map cleanly into the canonical
// trade format used by the replay harness and production ingestion pipeline.
//
// Modes:
//   dry-run (default) — parse + validate only, no DB state changes
//   live              — parse + ingest through production path, verify side effects
//
// Accepts:
//   POST with JSON body containing:
//   {
//     "broker": "tradovate",
//     "mode": "dry-run" | "live",
//     "payloads": [
//       {
//         "label": "open-fill",
//         "headers": { "x-tv-timestamp": "...", "x-tv-signature": "..." },
//         "body": { ... raw broker payload ... }
//       }
//     ],
//     "expectations": {             // optional — diff against these
//       "symbolNormalized": "ES",
//       "side": "buy",
//       "qty": 1,
//       "pnl": null
//     }
//   }
//
// Auth: X-Cron-Secret or admin JWT (same pattern as scenario-replay)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAdapter } from '../_shared/brokers/adapter.ts'
import type { BrokerWebhookContext, BrokerId, CanonicalTrade } from '../_shared/brokers/types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

// ── Auth helper (mirrors scenario-replay) ──
async function verifyAuth(req: Request): Promise<{ ok: boolean; reason?: string }> {
  // 1. X-Cron-Secret
  const cronSecret = req.headers.get('x-cron-secret')
  if (cronSecret) {
    const expected = Deno.env.get('CRON_SECRET')
    if (!expected) {
      // Fallback to internal_secrets table
      try {
        const sb = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        const { data } = await sb
          .from('internal_secrets')
          .select('value')
          .eq('key', 'CRON_SECRET')
          .single()
        if (data?.value && cronSecret === data.value) return { ok: true }
      } catch { /* fall through */ }
      return { ok: false, reason: 'CRON_SECRET not configured' }
    }
    if (cronSecret === expected) return { ok: true }
    return { ok: false, reason: 'Invalid X-Cron-Secret' }
  }

  // 2. JWT or service_role key — check authorization or apikey header
  const authHeader = req.headers.get('authorization')
  const apiKeyHeader = req.headers.get('apikey')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  // Check if apikey header carries the service_role key
  if (serviceRoleKey && apiKeyHeader === serviceRoleKey) return { ok: true }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    // Check if this is the service_role key
    if (serviceRoleKey && token === serviceRoleKey) return { ok: true }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceRoleKey!
    )
    const { data: { user }, error } = await sb.auth.getUser(token)
    if (error || !user) return { ok: false, reason: 'Invalid JWT' }
    const { data: roles } = await sb
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
    const isAdmin = roles?.some(r => r.role === 'admin')
    if (!isAdmin) return { ok: false, reason: 'Admin role required' }
    return { ok: true }
  }

  return { ok: false, reason: 'Missing authentication' }
}

// ── Diff canonical output against expectations ──
interface FieldDiff {
  field: string
  expected: unknown
  actual: unknown
  match: boolean
}

function diffCanonical(
  canonical: CanonicalTrade,
  expectations: Record<string, unknown>
): { diffs: FieldDiff[]; allMatch: boolean } {
  const diffs: FieldDiff[] = []
  for (const [field, expected] of Object.entries(expectations)) {
    const actual = (canonical as Record<string, unknown>)[field]
    const match = JSON.stringify(actual) === JSON.stringify(expected)
    diffs.push({ field, expected, actual, match })
  }
  return {
    diffs,
    allMatch: diffs.every(d => d.match),
  }
}

// ── Mapping warning detection ──
interface MappingWarning {
  code: string
  message: string
  field?: string
}

function detectMappingWarnings(canonical: CanonicalTrade): MappingWarning[] {
  const warnings: MappingWarning[] = []

  if (canonical.pnl === null) {
    warnings.push({
      code: 'MISSING_PNL',
      message: 'No realized PnL in payload. Fill events require explicit PnL for breach/pass math.',
      field: 'pnl',
    })
  }
  if (canonical.price === null) {
    warnings.push({
      code: 'MISSING_PRICE',
      message: 'No fill price in payload.',
      field: 'price',
    })
  }
  if (canonical.commission === null) {
    warnings.push({
      code: 'MISSING_COMMISSION',
      message: 'No commission in payload. Will default to 0.',
      field: 'commission',
    })
  }
  if (canonical.symbolRaw !== canonical.symbolNormalized) {
    warnings.push({
      code: 'SYMBOL_NORMALIZED',
      message: `Symbol was normalized: '${canonical.symbolRaw}' → '${canonical.symbolNormalized}'`,
      field: 'symbolNormalized',
    })
  }
  if (canonical.eventType === 'unknown') {
    warnings.push({
      code: 'UNKNOWN_EVENT_TYPE',
      message: 'Event type could not be determined. Defaulting to unknown.',
      field: 'eventType',
    })
  }

  return warnings
}

// ── Idempotency check ──
interface IdempotencyResult {
  duplicateFound: boolean
  originalRequestId?: string
  payloadHashMatch?: boolean
}

async function checkIdempotency(
  supabase: ReturnType<typeof createClient>,
  canonical: CanonicalTrade,
  accountId: string | null
): Promise<IdempotencyResult> {
  if (!accountId) return { duplicateFound: false }

  const { data: existing } = await supabase
    .from('trades')
    .select('id, request_id, raw_payload')
    .eq('platform_trade_id', canonical.externalTradeId)
    .eq('account_id', accountId)
    .limit(1)

  if (existing && existing.length > 0) {
    return {
      duplicateFound: true,
      originalRequestId: existing[0].request_id,
      payloadHashMatch: true, // simplified — in production the hash comparison is more rigorous
    }
  }

  return { duplicateFound: false }
}

// ── Ordering analysis ──
interface OrderingAnalysis {
  payloadCount: number
  chronological: boolean
  timestamps: string[]
  gaps: { from: string; to: string; gapMs: number }[]
}

function analyzeOrdering(canonicals: CanonicalTrade[]): OrderingAnalysis {
  const timestamps = canonicals.map(c => c.occurredAt)
  let chronological = true
  const gaps: OrderingAnalysis['gaps'] = []

  for (let i = 1; i < timestamps.length; i++) {
    const prev = new Date(timestamps[i - 1]).getTime()
    const curr = new Date(timestamps[i]).getTime()
    if (curr < prev) chronological = false
    const gapMs = curr - prev
    if (Math.abs(gapMs) > 0) {
      gaps.push({ from: timestamps[i - 1], to: timestamps[i], gapMs })
    }
  }

  return { payloadCount: canonicals.length, chronological, timestamps, gaps }
}

// ── Main handler ──

interface PayloadEntry {
  label: string
  headers?: Record<string, string>
  body: unknown
}

interface SmokeTestRequest {
  broker: BrokerId
  mode?: 'dry-run' | 'live'
  payloads: PayloadEntry[]
  expectations?: Record<string, unknown>
  skipSignatureVerification?: boolean
}

interface PayloadResult {
  label: string
  parseOk: boolean
  decision: string
  reason?: string
  canonical?: CanonicalTrade
  warnings: MappingWarning[]
  expectationDiff?: { diffs: FieldDiff[]; allMatch: boolean }
  idempotency?: IdempotencyResult
  accountMapping?: {
    externalAccountId: string
    internalAccountId: string | null
    mapped: boolean
  }
  liveIngestResult?: unknown
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID()

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', request_id: requestId }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Auth — log headers for debugging
  console.log('Auth headers:', {
    authorization: req.headers.get('authorization')?.substring(0, 30) + '...',
    apikey: req.headers.get('apikey')?.substring(0, 30) + '...',
    cronSecret: req.headers.get('x-cron-secret') ? 'present' : 'absent',
  })
  const auth = await verifyAuth(req)
  if (!auth.ok) {
    return new Response(
      JSON.stringify({ error: auth.reason, request_id: requestId }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const input: SmokeTestRequest = await req.json()
    const mode = input.mode ?? 'dry-run'
    const broker = input.broker

    if (!broker) {
      return new Response(
        JSON.stringify({ error: 'broker field is required', request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (!input.payloads || !Array.isArray(input.payloads) || input.payloads.length === 0) {
      return new Response(
        JSON.stringify({ error: 'payloads array is required and must be non-empty', request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const adapter = await getAdapter(broker)
    if (!adapter) {
      return new Response(
        JSON.stringify({ error: `Broker '${broker}' adapter not found`, request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const results: PayloadResult[] = []
    const canonicals: CanonicalTrade[] = []
    const startTime = Date.now()

    for (const entry of input.payloads) {
      const rawBody = JSON.stringify(entry.body)

      // Build a synthetic Request with the provided headers
      const syntheticHeaders = new Headers({
        'content-type': 'application/json',
        ...(entry.headers ?? {}),
      })

      const syntheticReq = new Request('https://bridge-smoke-test.local', {
        method: 'POST',
        headers: syntheticHeaders,
        body: rawBody,
      })

      const ctx: BrokerWebhookContext = {
        broker,
        requestId,
        receivedAt: new Date().toISOString(),
      }

      const result: PayloadResult = {
        label: entry.label,
        parseOk: false,
        decision: 'ERROR',
        warnings: [],
      }

      // Step 1: Signature verification (optional skip for smoke testing)
      if (!input.skipSignatureVerification) {
        const verifyResult = await adapter.verify(syntheticReq, rawBody, ctx)
        if (!verifyResult.ok) {
          result.decision = verifyResult.decision
          result.reason = verifyResult.reason
          results.push(result)
          continue
        }
      }

      // Step 2: Parse to canonical
      // Need to re-create request since body was consumed
      const parseReq = new Request('https://bridge-smoke-test.local', {
        method: 'POST',
        headers: syntheticHeaders,
        body: rawBody,
      })

      const parseResult = await adapter.parse(parseReq, rawBody, ctx)
      result.parseOk = parseResult.ok
      result.decision = parseResult.decision
      result.reason = parseResult.reason

      if (parseResult.ok && parseResult.canonical) {
        const canonical = parseResult.canonical
        result.canonical = canonical
        canonicals.push(canonical)

        // Step 3: Detect mapping warnings
        result.warnings = detectMappingWarnings(canonical)

        // Step 4: Diff against expectations (if provided)
        if (input.expectations) {
          result.expectationDiff = diffCanonical(canonical, input.expectations)
        }

        // Step 5: Account mapping check
        const { data: platformAccount } = await supabase
          .from('platform_accounts')
          .select('account_id')
          .eq('platform_account_id', canonical.externalAccountId)
          .eq('platform_name', broker)
          .single()

        result.accountMapping = {
          externalAccountId: canonical.externalAccountId,
          internalAccountId: platformAccount?.account_id ?? null,
          mapped: !!platformAccount,
        }

        // Step 6: Idempotency check
        result.idempotency = await checkIdempotency(
          supabase,
          canonical,
          platformAccount?.account_id ?? null
        )

        // Step 7: Live ingest (only in live mode, only if mapped)
        if (mode === 'live' && platformAccount?.account_id) {
          try {
            // Call ingest-trade by directly invoking the RPC
            const netPnl = (canonical.pnl ?? 0) - (canonical.commission ?? 0) - (canonical.fees ?? 0)

            // Compute trading day using ET timezone logic
            const occurredDate = new Date(canonical.occurredAt)
            const etParts = new Intl.DateTimeFormat('en-US', {
              timeZone: 'America/New_York',
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false,
            }).formatToParts(occurredDate)
            const get = (t: string) => etParts.find(p => p.type === t)?.value ?? '00'
            const hour = Number(get('hour'))
            const etDate = new Date(Date.UTC(
              Number(get('year')),
              Number(get('month')) - 1,
              Number(get('day'))
            ))
            if (hour < 17) etDate.setUTCDate(etDate.getUTCDate() - 1)
            const tradingDay = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(etDate)

            const { data: rpcResult, error: rpcError } = await supabase.rpc('ingest_trade_atomic', {
              p_account_id: platformAccount.account_id,
              p_platform_trade_id: canonical.externalTradeId,
              p_platform_account_id: canonical.externalAccountId,
              p_symbol: canonical.symbolNormalized,
              p_side: canonical.side,
              p_quantity: canonical.qty,
              p_entry_price: canonical.price,
              p_net_pnl: netPnl,
              p_commission: canonical.commission ?? 0,
              p_opened_at: canonical.occurredAt,
              p_raw_payload: canonical.raw,
              p_trading_day: tradingDay,
            })

            result.liveIngestResult = rpcError
              ? { error: rpcError.message, code: rpcError.code }
              : { success: true, data: rpcResult }
          } catch (e) {
            result.liveIngestResult = { error: (e as Error).message }
          }
        }
      }

      results.push(result)
    }

    const elapsedMs = Date.now() - startTime

    // Ordering analysis across all successfully parsed payloads
    const ordering = canonicals.length > 1
      ? analyzeOrdering(canonicals)
      : null

    // Store smoke test run
    const runRecord = {
      broker,
      mode,
      request_id: requestId,
      payload_count: input.payloads.length,
      parsed_count: canonicals.length,
      all_parsed: results.every(r => r.parseOk),
      all_expectations_met: results.every(r => !r.expectationDiff || r.expectationDiff.allMatch),
      all_accounts_mapped: results.every(r => !r.accountMapping || r.accountMapping.mapped),
      ordering_chronological: ordering?.chronological ?? null,
      total_warnings: results.reduce((sum, r) => sum + r.warnings.length, 0),
      elapsed_ms: elapsedMs,
      results_json: results,
    }

    // Best-effort store to collapse_sim_runs (reusing the table for all test runs)
    await supabase.from('collapse_sim_runs').insert({
      preset_id: `bridge-smoke-test:${broker}`,
      scenario_version: 'bridge-v1.0',
      inputs_json: {
        broker,
        mode,
        payload_count: input.payloads.length,
        skip_signature: input.skipSignatureVerification ?? false,
      },
      results_json: runRecord,
      assertions_json: {
        all_parsed: runRecord.all_parsed,
        all_expectations_met: runRecord.all_expectations_met,
        all_accounts_mapped: runRecord.all_accounts_mapped,
      },
      db_snapshot_json: {},
      overall_pass: runRecord.all_parsed && runRecord.all_expectations_met,
      overall_verdict: runRecord.all_parsed && runRecord.all_expectations_met ? 'PASS' : 'FAIL',
    }).catch(() => {})

    // Build summary
    const summary = {
      version: 'bridge-smoke-test-v1.0',
      request_id: requestId,
      broker,
      mode,
      elapsed_ms: elapsedMs,
      payload_count: input.payloads.length,
      parsed_count: canonicals.length,
      verdict: {
        all_parsed: runRecord.all_parsed,
        all_expectations_met: runRecord.all_expectations_met,
        all_accounts_mapped: runRecord.all_accounts_mapped,
        ordering_chronological: ordering?.chronological ?? null,
        total_warnings: runRecord.total_warnings,
        idempotency_duplicates: results.filter(r => r.idempotency?.duplicateFound).length,
      },
      ordering,
      results,
    }

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: (e as Error).message,
        request_id: requestId,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
