import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Solvency bands — kept in sync with src/lib/competitor-recommendation.ts.
// Defense in depth: the UI clamps these, but the server enforces them too.
const BANDS = {
  profit_target_percent: [8, 12],
  max_daily_loss_percent: [3, 5],
  max_total_drawdown_percent: [4, 10],
  payout_split_percent: [80, 95],
  payout_cooldown_days: [7, 21],
  min_trading_days: [1, 30],
} as const

const ALLOWED_TIERS = new Set(['starter', 'pro', 'elite'])

function withinBand(field: keyof typeof BANDS, value: number): boolean {
  const [lo, hi] = BANDS[field]
  return value >= lo && value <= hi
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const headers = { ...corsHeaders, 'Content-Type': 'application/json' }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // ── Auth: caller JWT ──
    const authHeader = req.headers.get('authorization') ?? ''
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!jwt) {
      return new Response(JSON.stringify({ error: 'Missing Authorization bearer token' }), { status: 401, headers })
    }

    const authed = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    })

    const { data: userRes, error: userErr } = await authed.auth.getUser()
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: 'Invalid JWT' }), { status: 401, headers })
    }
    const caller = userRes.user

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // ── Role check: admin only ──
    const { data: isAdmin, error: roleErr } = await supabase.rpc('has_role', {
      _user_id: caller.id,
      _role: 'admin',
    })
    if (roleErr || isAdmin !== true) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers })
    }

    const { tier_id, proposed_cohort, source_snapshot_ids, source_firms } = body as {
      tier_id?: string
      proposed_cohort?: Record<string, unknown>
      source_snapshot_ids?: string[]
      source_firms?: string[]
    }

    if (!tier_id || !ALLOWED_TIERS.has(tier_id)) {
      return new Response(JSON.stringify({ error: 'Invalid tier_id' }), { status: 400, headers })
    }
    if (!proposed_cohort || typeof proposed_cohort !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing proposed_cohort' }), { status: 400, headers })
    }

    // ── Validate every numeric field is within solvency bands ──
    for (const field of Object.keys(BANDS) as Array<keyof typeof BANDS>) {
      const v = proposed_cohort[field]
      if (typeof v !== 'number' || !Number.isFinite(v) || !withinBand(field, v)) {
        return new Response(
          JSON.stringify({ error: `Field ${field}=${v} is outside solvency band ${JSON.stringify(BANDS[field])}` }),
          { status: 400, headers },
        )
      }
    }

    // Specific extra checks
    const entryFee = Number(proposed_cohort.entry_fee)
    if (!Number.isFinite(entryFee) || entryFee < 50 || entryFee > 1000) {
      return new Response(JSON.stringify({ error: 'entry_fee out of bounds [50, 1000]' }), { status: 400, headers })
    }
    const firstCap = Number(proposed_cohort.first_payout_cap_amount)
    if (!Number.isFinite(firstCap) || firstCap < 300 || firstCap > entryFee * 20) {
      return new Response(JSON.stringify({ error: 'first_payout_cap_amount out of bounds' }), { status: 400, headers })
    }

    // ── Compute next version ──
    const { data: maxRow } = await supabase
      .from('cohorts')
      .select('version')
      .eq('tier_id', tier_id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextVersion = (maxRow?.version ?? 0) + 1

    // ── Insert dormant draft row ──
    const insertRow = {
      name: String(proposed_cohort.name ?? `Recommended ${tier_id}`),
      tier_id,
      cohort_phase: 'performance',
      description: String(proposed_cohort.description ?? ''),
      version: nextVersion,
      is_active: false,
      intake_active: false,
      entry_fee: entryFee,
      profit_target_percent: Number(proposed_cohort.profit_target_percent),
      max_daily_loss_percent: Number(proposed_cohort.max_daily_loss_percent),
      max_total_drawdown_percent: Number(proposed_cohort.max_total_drawdown_percent),
      min_trading_days: Number(proposed_cohort.min_trading_days),
      payout_split_percent: Number(proposed_cohort.payout_split_percent),
      max_payout_percent: Number(proposed_cohort.payout_split_percent),
      first_payout_cap_amount: firstCap,
      lifetime_cap_multiple: Number(proposed_cohort.lifetime_cap_multiple ?? 10),
      payout_cooldown_days: Number(proposed_cohort.payout_cooldown_days),
      created_by: caller.id,
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('cohorts')
      .insert(insertRow)
      .select('id, name, version')
      .single()
    if (insertErr || !inserted) {
      console.error('cohort insert failed', insertErr)
      return new Response(JSON.stringify({ error: 'Could not create draft cohort' }), { status: 500, headers })
    }

    // ── Audit trail ──
    // audit_logs has a hash-chain trigger; we just insert the action row.
    await supabase.from('audit_logs').insert({
      action: 'cohort_draft_created',
      user_id: caller.id,
      details: {
        cohort_id: inserted.id,
        tier_id,
        proposed: insertRow,
        source_snapshot_ids: source_snapshot_ids ?? [],
        source_firms: source_firms ?? [],
      },
      idempotency_key: `cohort_draft_${inserted.id}`,
      prev_hash: '',
      row_hash: '',
    }).then(({ error }) => {
      if (error) console.warn('audit_logs insert failed (non-fatal):', error.message)
    })

    return new Response(
      JSON.stringify({ ok: true, cohort_id: inserted.id, name: inserted.name, version: inserted.version }),
      { status: 200, headers },
    )
  } catch (e) {
    console.error('recommend-cohort-draft error', e)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers })
  }
})
