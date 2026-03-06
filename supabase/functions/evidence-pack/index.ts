import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface EvidencePackRequest {
  account_id: string
}

interface EvidencePack {
  generated_at: string
  account: {
    id: string
    account_number: string
    status: string
    created_at: string
    passed_at: string | null
    failed_at: string | null
    starting_balance: number
    current_balance: number
    highest_balance: number
    total_pnl: number
    trading_days_count: number
    rule_snapshot: Record<string, unknown>
  }
  trades: Array<{
    id: string
    platform_trade_id: string | null
    platform_account_id: string | null
    symbol: string
    side: string
    quantity: number
    entry_price: number
    pnl: number | null
    commission: number | null
    opened_at: string
    status: string
    raw_payload_hash: string | null
  }>
  violations: Array<{
    id: string
    trade_id: string | null
    platform_trade_id: string | null
    rule_type: string
    rule_threshold: number | null
    actual_value: number | null
    description: string
    detected_at: string
    breach_day: string | null
    confirmed_by: string | null
    confirmed_at: string | null
    confirmation_notes: string | null
  }>
  account_events: Array<{
    id: string
    event_type: string
    event_data: Record<string, unknown>
    created_at: string
    request_id: string | null
  }>
  audit_logs: Array<{
    id: string
    action: string
    details: Record<string, unknown>
    reason: string | null
    created_at: string
    request_id: string | null
    user_id: string | null
  }>
  integrity: {
    sha256_hash: string
    record_counts: {
      trades: number
      violations: number
      account_events: number
      audit_logs: number
    }
  }
}

// Deep stable stringify for deterministic hashing (handles nested objects + arrays)
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

// Compute SHA-256 hash of JSON string
async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Hash raw_payload for inclusion without exposing full data
async function hashPayload(payload: unknown): Promise<string | null> {
  if (!payload) return null
  try {
    const canonical = JSON.stringify(stableSort(payload))
    return await computeHash(canonical)
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Create service role client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    // Validate auth token and check role
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if user has staff role (risk_officer, support, or admin)
    const { data: roles, error: roleError } = await supabase.rpc('get_user_roles', {
      _user_id: user.id
    })

    if (roleError) {
      console.error('Role check error:', roleError)
      return new Response(
        JSON.stringify({ error: 'Failed to verify user roles' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const staffRoles = ['risk_officer', 'support', 'admin']
    const hasStaffRole = (roles as string[] || []).some(r => staffRoles.includes(r))
    
    if (!hasStaffRole) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions. Staff role required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: EvidencePackRequest = await req.json()
    
    if (!body.account_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: account_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Fetch account with all details
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', body.account_id)
      .single()

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: 'Account not found', details: accountError?.message }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Fetch all trades for this account
    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', body.account_id)
      .order('opened_at', { ascending: true })

    if (tradesError) {
      console.error('Trades fetch error:', tradesError)
    }

    // Fetch all violations
    const { data: violations, error: violationsError } = await supabase
      .from('violations')
      .select('*')
      .eq('account_id', body.account_id)
      .order('detected_at', { ascending: true })

    if (violationsError) {
      console.error('Violations fetch error:', violationsError)
    }

    // Fetch account events (trader-visible timeline)
    const { data: accountEvents, error: eventsError } = await supabase
      .from('account_events')
      .select('*')
      .eq('account_id', body.account_id)
      .order('created_at', { ascending: true })

    if (eventsError) {
      console.error('Account events fetch error:', eventsError)
    }

    // Fetch audit logs (internal decisions)
    const { data: auditLogs, error: logsError } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('account_id', body.account_id)
      .order('created_at', { ascending: true })

    if (logsError) {
      console.error('Audit logs fetch error:', logsError)
    }

    // Process trades to include payload hashes
    const processedTrades = await Promise.all(
      (trades || []).map(async (trade) => ({
        id: trade.id,
        platform_trade_id: trade.platform_trade_id,
        platform_account_id: trade.platform_account_id,
        symbol: trade.symbol,
        side: trade.side,
        quantity: Number(trade.quantity),
        entry_price: Number(trade.entry_price),
        pnl: trade.pnl !== null ? Number(trade.pnl) : null,
        commission: trade.commission !== null ? Number(trade.commission) : null,
        opened_at: trade.opened_at,
        status: trade.status,
        raw_payload_hash: await hashPayload(trade.raw_payload)
      }))
    )

    // Process violations
    const processedViolations = (violations || []).map(v => ({
      id: v.id,
      trade_id: v.trade_id,
      platform_trade_id: v.platform_trade_id,
      rule_type: v.rule_type,
      rule_threshold: v.rule_threshold !== null ? Number(v.rule_threshold) : null,
      actual_value: v.actual_value !== null ? Number(v.actual_value) : null,
      description: v.description,
      detected_at: v.detected_at,
      breach_day: v.breach_day,
      confirmed_by: v.confirmed_by,
      confirmed_at: v.confirmed_at,
      confirmation_notes: v.confirmation_notes
    }))

    // Process account events
    const processedEvents = (accountEvents || []).map(e => ({
      id: e.id,
      event_type: e.event_type,
      event_data: e.event_data,
      created_at: e.created_at,
      request_id: e.request_id
    }))

    // Process audit logs (redact ip_address and user_agent for privacy)
    const processedLogs = (auditLogs || []).map(l => ({
      id: l.id,
      action: l.action,
      details: l.details,
      reason: l.reason,
      created_at: l.created_at,
      request_id: l.request_id,
      user_id: l.user_id
    }))

    // Build the evidence pack (without integrity hash first)
    const packData = {
      account: {
        id: account.id,
        account_number: account.account_number,
        status: account.status,
        created_at: account.created_at,
        passed_at: account.passed_at,
        failed_at: account.failed_at,
        starting_balance: Number(account.starting_balance),
        current_balance: Number(account.current_balance),
        highest_balance: Number(account.highest_balance),
        total_pnl: Number(account.total_pnl),
        trading_days_count: account.trading_days_count,
        rule_snapshot: account.rule_snapshot || {}
      },
      trades: processedTrades,
      violations: processedViolations,
      account_events: processedEvents,
      audit_logs: processedLogs
    }

    // Compute integrity hash over deep-stable-sorted, deterministic JSON
    const canonical = JSON.stringify(stableSort(packData))
    const integrityHash = await computeHash(canonical)

    // Build final evidence pack
    const evidencePack: EvidencePack = {
      generated_at: new Date().toISOString(),
      ...packData,
      integrity: {
        sha256_hash: integrityHash,
        record_counts: {
          trades: processedTrades.length,
          violations: processedViolations.length,
          account_events: processedEvents.length,
          audit_logs: processedLogs.length
        }
      }
    }

    // Generate request_id for idempotent audit logging
    const requestId = crypto.randomUUID()

    // Log this export for audit trail (idempotent via request_id)
    await supabase.from('audit_logs').upsert({
      account_id: body.account_id,
      user_id: user.id,
      action: 'evidence_pack_exported',
      request_id: requestId,
      details: {
        integrity_hash: integrityHash,
        record_counts: evidencePack.integrity.record_counts,
        exported_by: user.email
      },
      reason: 'Evidence pack generated for dispute/audit purposes'
    }, { onConflict: 'account_id,request_id', ignoreDuplicates: true })

    return new Response(
      JSON.stringify(evidencePack),
      { 
        status: 200, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'X-Evidence-Pack-Hash': integrityHash
        } 
      }
    )

  } catch (err) {
    const error = err as Error
    console.error('Evidence pack generation error:', error)
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
