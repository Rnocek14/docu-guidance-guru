import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // ── Environment guard: never run in production ──
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const appEnv = Deno.env.get('APP_ENV') ?? ''
  if (appEnv === 'production' || (!supabaseUrl.includes('sfxmgwkrjwuerfkqxokq') && appEnv !== 'test')) {
    return new Response(JSON.stringify({ error: 'QA endpoint disabled in production' }), { status: 403, headers })
  }

  try {
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
      return new Response(JSON.stringify({ error: 'Invalid JWT', details: userErr?.message }), { status: 401, headers })
    }
    const caller = userRes.user

    // Service client for DB ops
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // ── Role check: admin only ──
    const { data: isAdmin, error: roleErr } = await supabase.rpc('has_role', {
      _user_id: caller.id,
      _role: 'admin',
    })

    if (roleErr || isAdmin !== true) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers })
    }

    const { payout_id } = await req.json()
    if (!payout_id) {
      return new Response(JSON.stringify({ error: 'Missing payout_id' }), { status: 400, headers })
    }

    // ── Guard: payout exists + SEEDV2/DEMO only ──
    const { data: payoutRow, error: payoutErr } = await supabase
      .from('payouts')
      .select('id, status, amount, account_id')
      .eq('id', payout_id)
      .single()

    if (payoutErr || !payoutRow) {
      return new Response(JSON.stringify({ error: 'Payout not found', details: payoutErr?.message }), { status: 404, headers })
    }

    const { data: acct, error: acctErr } = await supabase
      .from('accounts')
      .select('id, account_number, status')
      .eq('id', payoutRow.account_id)
      .single()

    if (acctErr || !acct) {
      return new Response(JSON.stringify({ error: 'Account not found', details: acctErr?.message }), { status: 404, headers })
    }

    if (!acct.account_number.startsWith('SEEDV2-') && !acct.account_number.startsWith('DEMO-')) {
      return new Response(
        JSON.stringify({ error: 'Restricted to SEEDV2/DEMO only', account_number: acct.account_number }),
        { status: 403, headers }
      )
    }

    if (!['pending', 'under_review'].includes(payoutRow.status)) {
      return new Response(
        JSON.stringify({ error: `Not approvable (status=${payoutRow.status})` }),
        { status: 400, headers }
      )
    }

    // ── BEFORE snapshots ──
    const [beforeAuditRes, beforeEventsRes] = await Promise.all([
      supabase
        .from('audit_logs')
        .select('action, user_id, reason, created_at')
        .eq('account_id', acct.id)
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('account_events')
        .select('event_type, created_at')
        .eq('account_id', acct.id)
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    const beforeAudit = beforeAuditRes.data
    const beforeEvents = beforeEventsRes.data

    // ── Call payout-actions edge function (full production path) ──
    const payoutActionsUrl = `${supabaseUrl}/functions/v1/payout-actions`
    const paResponse = await fetch(payoutActionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({
        action: 'approve',
        payout_id,
        reason: 'QA automated approval test',
      }),
    })

    const paBody = await paResponse.json()

    if (!paResponse.ok) {
      return new Response(
        JSON.stringify({ error: 'payout-actions approve failed', status: paResponse.status, details: paBody }),
        { status: 500, headers }
      )
    }

    // ── AFTER snapshots ──
    const [afterPayoutRes, afterAccountRes, afterAuditRes, afterEventsRes] = await Promise.all([
      supabase.from('payouts').select('status, reviewed_at, approved_by').eq('id', payout_id).single(),
      supabase.from('accounts').select('status, account_number').eq('id', acct.id).single(),
      supabase.from('audit_logs').select('action, user_id, reason, created_at').eq('account_id', acct.id).order('created_at', { ascending: false }).limit(5),
      supabase.from('account_events').select('event_type, created_at').eq('account_id', acct.id).order('created_at', { ascending: false }).limit(10),
    ])

    // ── Assertions ──
    const assertions = {
      payout_status_approved: afterPayoutRes.data?.status === 'approved',
      payout_has_reviewer: !!afterPayoutRes.data?.approved_by,
      account_status_payout_approved: afterAccountRes.data?.status === 'payout_approved',
      audit_log_increased: (afterAuditRes.data?.length ?? 0) > (beforeAudit?.length ?? 0),
      events_increased: (afterEventsRes.data?.length ?? 0) > (beforeEvents?.length ?? 0),
    }

    const result = Object.values(assertions).every(Boolean) ? 'PASS' : 'FAIL'

    return new Response(JSON.stringify({
      result,
      assertions,
      payout_id,
      account_number: acct.account_number,
      before: {
        payout_status: payoutRow.status,
        account_status: acct.status,
        audit_count: beforeAudit?.length ?? 0,
        event_count: beforeEvents?.length ?? 0,
      },
      after: {
        payout: afterPayoutRes.data,
        account: afterAccountRes.data,
        audit: afterAuditRes.data,
        events: afterEventsRes.data,
      },
      payout_actions_response: paBody,
    }, null, 2), { status: 200, headers })

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Unexpected error', details: String(err) }), { status: 500, headers })
  }
})
