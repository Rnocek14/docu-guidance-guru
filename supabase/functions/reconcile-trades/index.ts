import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ExternalTrade {
  platform_trade_id: string
  symbol: string
  side: string
  quantity: number
  entry_price: number
  pnl: number | null
  opened_at: string
}

interface ReconcileRequest {
  account_id: string
  platform_account_id: string
  from_ts: string
  to_ts: string
  trades: ExternalTrade[]
}

interface MismatchDetail {
  platform_trade_id: string
  field: string
  external_value: unknown
  internal_value: unknown
}

interface TimestampDelta {
  platform_trade_id: string
  external_opened_at: string
  internal_opened_at: string
  delta_ms: number
}

interface ReconcileResult {
  request_id: string
  account_id: string
  platform_account_id: string
  time_range: { from: string; to: string }
  summary: {
    external_count: number
    valid_external_count: number
    invalid_external_count: number
    internal_count: number
    matched_count: number
    missing_in_db_count: number
    extra_in_db_count: number
    mismatched_count: number
    timestamp_warnings_count: number
  }
  invalid_external: string[]
  missing_in_db: string[]
  extra_in_db: string[]
  mismatched: MismatchDetail[]
  timestamp_deltas: TimestampDelta[]
  integrity_hash: string
  reconciled_at: string
}

// ============ SYMBOL NORMALIZATION ============
// Futures month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec
const MONTH_CODES = 'FGHJKMNQUVXZ'

// Known base symbols for direct matching (covers edge cases like numeric-leading symbols)
const KNOWN_BASE_SYMBOLS = new Set([
  // E-mini and Micro indices
  'ES', 'NQ', 'YM', 'RTY', 'MES', 'MNQ', 'MYM', 'M2K',
  // Energy
  'CL', 'NG', 'HO', 'RB', 'MCL',
  // Metals
  'GC', 'SI', 'HG', 'PL', 'MGC',
  // Currencies (numeric-leading)
  '6E', '6B', '6J', '6A', '6C', '6S', '6N', '6M',
  // Bonds
  'ZB', 'ZN', 'ZT', 'ZF', 'UB',
  // Agricultural
  'ZC', 'ZS', 'ZW', 'ZM', 'ZL', 'LE', 'HE', 'GF',
])

/**
 * Normalize a trading symbol for comparison
 * Uses regex to extract base symbol from futures contract format: BASE + MONTH_CODE + YEAR
 * Examples: NQZ5 -> NQ, ESM24 -> ES, 6EH6 -> 6E, MNQU5 -> MNQ
 * 
 * Handles vendor-specific formats:
 * - Exchange suffixes: NQZ5-CME -> NQ, ESM24-CBOT -> ES
 * - Trailing punctuation: MNQU5! -> MNQ, CLZ5. -> CL
 * - Prefix exchanges: CME:NQZ5 -> NQ
 * 
 * IMPORTANT: Only strips contract suffix if base is a KNOWN futures symbol.
 * This prevents accidentally normalizing equities like AAPL -> AAP.
 */
function normalizeSymbol(symbol: string): string {
  if (!symbol) return ''

  const upper = symbol.trim().toUpperCase()

  // Step 1: Handle prefix exchange codes (CME:NQZ5 -> NQZ5)
  const prefixSplit = upper.split(':')
  const preToken = prefixSplit.length > 1 ? prefixSplit[prefixSplit.length - 1] : upper

  // Step 2: Remove obvious trailing punctuation like "!" "." (but keep separators for splitting)
  const trimmed = preToken.replace(/[!]+$/g, '').replace(/[.]+$/g, '')

  // Step 3: Split on vendor separators and take the first token (contract code)
  // Examples:
  //  - "NQZ5-CME" -> "NQZ5"
  //  - "ES.M24"   -> "ES" (first token)
  //  - "CL_Z5"    -> "CL" (first token)
  const token = trimmed.split(/[-._]/)[0]

  // Step 4: Remove any remaining non-alphanumerics inside token (rare edge cases)
  const cleaned = token.replace(/[^A-Z0-9]/g, '')

  // Step 5: Futures contract extraction (only strip if base is known)
  // Regex: capture base symbol, then month code + optional year digits
  // Pattern: ^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,4})?$
  const futuresMatch = cleaned.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,4})?$/)
  
  if (futuresMatch) {
    const [, base, monthCode] = futuresMatch
    // Only strip if:
    // 1. The month code is valid, AND
    // 2. The base is a KNOWN futures symbol
    if (MONTH_CODES.includes(monthCode) && KNOWN_BASE_SYMBOLS.has(base)) {
      return base
    }
    // If base isn't known, do NOT strip - could be an equity or unknown instrument
    // Return cleaned version unchanged
  }

  // Step 6: Fallback - check if stripping trailing digits yields a known base
  // (handles formats like ES24 without month code)
  const strippedDigits = cleaned.replace(/\d+$/, '')
  if (KNOWN_BASE_SYMBOLS.has(strippedDigits)) {
    return strippedDigits
  }

  // Return cleaned but otherwise unchanged (preserves equities like AAPL)
  return cleaned
}

// Deep stable stringify for deterministic hashing
function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort)
  if (value && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = stableSort(obj[k])
      return acc
    }, {} as Record<string, unknown>)
  }
  return value
}

async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Timestamp tolerance for flagging (5 seconds)
const TIMESTAMP_TOLERANCE_MS = 5000

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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // Validate auth token and check role
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header', request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token', request_id: requestId }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if user has staff role
    const { data: roles, error: roleError } = await supabase.rpc('get_user_roles', {
      _user_id: user.id
    })

    if (roleError) {
      console.error('Role check error:', roleError)
      return new Response(
        JSON.stringify({ error: 'Failed to verify user roles', request_id: requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const staffRoles = ['risk_officer', 'support', 'admin']
    const hasStaffRole = (roles as string[] || []).some(r => staffRoles.includes(r))
    
    if (!hasStaffRole) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Staff role required.', request_id: requestId }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: ReconcileRequest = await req.json()
    
    if (!body.account_id || !body.platform_account_id || !body.from_ts || !body.to_ts || !body.trades) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: account_id, platform_account_id, from_ts, to_ts, trades', request_id: requestId }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify account exists and platform mapping is correct
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, account_number')
      .eq('id', body.account_id)
      .single()

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: 'Account not found', request_id: requestId }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify platform_account_id mapping exists for this account
    const { data: platformMapping, error: mappingError } = await supabase
      .from('platform_accounts')
      .select('id')
      .eq('account_id', body.account_id)
      .eq('platform_account_id', body.platform_account_id)
      .single()

    if (mappingError || !platformMapping) {
      return new Response(
        JSON.stringify({ 
          error: 'Platform account mapping not found for this account', 
          account_id: body.account_id,
          platform_account_id: body.platform_account_id,
          request_id: requestId 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate external trades - reject any without platform_trade_id
    const invalidExternal: string[] = []
    const validExternalTrades: ExternalTrade[] = []
    
    for (let i = 0; i < body.trades.length; i++) {
      const t = body.trades[i]
      if (!t.platform_trade_id || t.platform_trade_id.trim() === '') {
        invalidExternal.push(`index_${i}`)
      } else {
        validExternalTrades.push(t)
      }
    }

    // Fetch internal trades for the time range, filtered by platform_account_id
    const { data: internalTrades, error: tradesError } = await supabase
      .from('trades')
      .select('platform_trade_id, symbol, side, quantity, entry_price, pnl, opened_at')
      .eq('account_id', body.account_id)
      .eq('platform_account_id', body.platform_account_id)
      .gte('opened_at', body.from_ts)
      .lte('opened_at', body.to_ts)
      .order('opened_at', { ascending: true })

    if (tradesError) {
      console.error('Trades fetch error:', tradesError)
      return new Response(
        JSON.stringify({ error: 'Failed to fetch internal trades', request_id: requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Build lookup maps
    const externalMap = new Map<string, ExternalTrade>()
    for (const t of validExternalTrades) {
      externalMap.set(t.platform_trade_id, t)
    }

    const internalMap = new Map<string, typeof internalTrades[0]>()
    for (const t of internalTrades || []) {
      if (t.platform_trade_id) {
        internalMap.set(t.platform_trade_id, t)
      }
    }

    // Find discrepancies
    const missingInDb: string[] = []
    const extraInDb: string[] = []
    const mismatched: MismatchDetail[] = []
    const timestampDeltas: TimestampDelta[] = []

    // Check external trades against internal (with field normalization)
    for (const [platformId, extTrade] of externalMap) {
      const intTrade = internalMap.get(platformId)
      if (!intTrade) {
        missingInDb.push(platformId)
      } else {
        // Normalize and compare symbols (handles contract aliases)
        const extSymbolNorm = normalizeSymbol(extTrade.symbol)
        const intSymbolNorm = normalizeSymbol(intTrade.symbol)
        if (extSymbolNorm !== intSymbolNorm) {
          mismatched.push({
            platform_trade_id: platformId,
            field: 'symbol',
            external_value: extTrade.symbol,
            internal_value: intTrade.symbol
          })
        }

        // Normalize and compare side
        const extSide = (extTrade.side || '').trim().toLowerCase()
        const intSide = (intTrade.side || '').trim().toLowerCase()
        if (extSide !== intSide) {
          mismatched.push({
            platform_trade_id: platformId,
            field: 'side',
            external_value: extTrade.side,
            internal_value: intTrade.side
          })
        }

        // Compare PnL with tolerance (handles rounding differences)
        if (extTrade.pnl !== null && intTrade.pnl !== null) {
          const pnlDiff = Math.abs(Number(extTrade.pnl) - Number(intTrade.pnl))
          if (pnlDiff > 0.01) {
            mismatched.push({
              platform_trade_id: platformId,
              field: 'pnl',
              external_value: extTrade.pnl,
              internal_value: intTrade.pnl
            })
          }
        }

        // Compare quantity with tolerance
        const qtyDiff = Math.abs(Number(extTrade.quantity) - Number(intTrade.quantity))
        if (qtyDiff > 0.0001) {
          mismatched.push({
            platform_trade_id: platformId,
            field: 'quantity',
            external_value: extTrade.quantity,
            internal_value: intTrade.quantity
          })
        }

        // Check timestamp delta (for audit reporting, not blocking)
        if (extTrade.opened_at && intTrade.opened_at) {
          const extTime = new Date(extTrade.opened_at).getTime()
          const intTime = new Date(intTrade.opened_at).getTime()
          const deltaMs = Math.abs(extTime - intTime)
          
          if (deltaMs > TIMESTAMP_TOLERANCE_MS) {
            timestampDeltas.push({
              platform_trade_id: platformId,
              external_opened_at: extTrade.opened_at,
              internal_opened_at: intTrade.opened_at,
              delta_ms: deltaMs
            })
          }
        }
      }
    }

    // Check internal trades not in external
    for (const [platformId] of internalMap) {
      if (!externalMap.has(platformId)) {
        extraInDb.push(platformId)
      }
    }

    // Calculate matched count
    const matchedCount = externalMap.size - missingInDb.length

    // Build result data (without integrity hash first)
    // IMPORTANT: invalid_external must be included in hash input
    const resultData = {
      account_id: body.account_id,
      platform_account_id: body.platform_account_id,
      time_range: { from: body.from_ts, to: body.to_ts },
      summary: {
        external_count: body.trades.length,
        valid_external_count: validExternalTrades.length,
        invalid_external_count: invalidExternal.length,
        internal_count: internalMap.size,
        matched_count: matchedCount,
        missing_in_db_count: missingInDb.length,
        extra_in_db_count: extraInDb.length,
        mismatched_count: mismatched.length,
        timestamp_warnings_count: timestampDeltas.length
      },
      invalid_external: invalidExternal.sort(),
      missing_in_db: missingInDb.sort(),
      extra_in_db: extraInDb.sort(),
      mismatched: mismatched.sort((a, b) => a.platform_trade_id.localeCompare(b.platform_trade_id)),
      timestamp_deltas: timestampDeltas.sort((a, b) => a.platform_trade_id.localeCompare(b.platform_trade_id))
    }

    // Compute integrity hash (includes ALL result data for tamper detection)
    const canonical = JSON.stringify(stableSort(resultData))
    const integrityHash = await computeHash(canonical)

    // Build final result
    const result: ReconcileResult = {
      request_id: requestId,
      ...resultData,
      integrity_hash: integrityHash,
      reconciled_at: new Date().toISOString()
    }

    // Persist to reconciliation_runs table (idempotent via request_id)
    const { error: insertError } = await supabase.from('reconciliation_runs').upsert({
      account_id: body.account_id,
      platform_account_id: body.platform_account_id,
      from_ts: body.from_ts,
      to_ts: body.to_ts,
      summary: resultData.summary,
      missing_in_db: resultData.missing_in_db,
      extra_in_db: resultData.extra_in_db,
      mismatched: resultData.mismatched,
      invalid_external: resultData.invalid_external,
      timestamp_deltas: resultData.timestamp_deltas,
      integrity_hash: integrityHash,
      request_id: requestId,
      created_by: user.id
    }, { onConflict: 'account_id,request_id', ignoreDuplicates: true })

    if (insertError) {
      console.error('Reconciliation run insert error:', insertError)
      // Non-fatal: continue to return result even if persistence fails
    }

    // Log reconciliation run to audit_logs as well (belt-and-suspenders)
    await supabase.from('audit_logs').upsert({
      account_id: body.account_id,
      user_id: user.id,
      action: 'trade_reconciliation_run',
      request_id: requestId,
      details: {
        platform_account_id: body.platform_account_id,
        time_range: resultData.time_range,
        summary: resultData.summary,
        integrity_hash: integrityHash,
        reconciled_by: user.email,
        persisted_to_reconciliation_runs: !insertError
      },
      reason: 'Trade reconciliation performed for dispute/audit purposes'
    }, { onConflict: 'account_id,request_id', ignoreDuplicates: true })

    return new Response(
      JSON.stringify(result),
      { 
        status: 200, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'X-Reconciliation-Hash': integrityHash
        } 
      }
    )

  } catch (err) {
    const error = err as Error
    console.error('Reconciliation error:', error)
    
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', request_id: requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
