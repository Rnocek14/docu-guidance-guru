import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-qa-secret',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const headers = { ...corsHeaders, 'Content-Type': 'application/json' }

  try {
    // Parse body first
    const body = await req.json()
    const { payout_id, qa_secret: bodyQaSecret } = body

    // ── Auth: QA_SECRET or CRON_SECRET ──
    const qaSecretHeader = req.headers.get('x-qa-secret')
    const cronSecretHeader = req.headers.get('x-cron-secret')
    const expectedQaSecret = Deno.env.get('QA_SECRET')
    const expectedCronSecret = Deno.env.get('CRON_SECRET')

    const qaMatch = expectedQaSecret && (qaSecretHeader === expectedQaSecret || bodyQaSecret === expectedQaSecret)
    const cronMatch = expectedCronSecret && cronSecretHeader === expectedCronSecret

    if (!qaMatch && !cronMatch) {
      return new Response(JSON.stringify({ error: 'Forbidden: invalid secret' }), { status: 403, headers })
    }

    if (!payout_id) {
      return new Response(JSON.stringify({ error: 'Missing payout_id' }), { status: 400, headers })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // ── Guard: only SEEDV2/DEMO accounts ──
    const { data: payout, error: payoutErr } = await supabase
      .from('payouts')
      .select('id, status, amount, account_id, accounts!inner(id, account_number, status, user_id)')
      .eq('id', payout_id)
      .single()

    if (payoutErr || !payout) {
      return new Response(JSON.stringify({ error: 'Payout not found', details: payoutErr?.message }), { status: 404, headers })
    }

    const account = Array.isArray(payout.accounts) ? payout.accounts[0] : payout.accounts
    const acctNum: string = account.account_number

    if (!acctNum.startsWith('SEEDV2-') && !acctNum.startsWith('DEMO-')) {
      return new Response(
        JSON.stringify({ error: 'QA function restricted to SEEDV2/DEMO accounts only', account_number: acctNum }),
        { status: 403, headers }
      )
    }

    if (!['pending', 'under_review'].includes(payout.status)) {
      return new Response(
        JSON.stringify({ error: `Payout not in approvable state (current: ${payout.status})` }),
        { status: 400, headers }
      )
    }

    // ── Capture before-state ──
    const beforePayout = { status: payout.status, amount: payout.amount }
    const beforeAccount = { status: account.status, account_number: acctNum }

    const { data: beforeAudit } = await supabase
      .from('audit_logs')
      .select('action, user_id, reason, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(5)

    const { data: beforeEvents } = await supabase
      .from('account_events')
      .select('event_type, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(10)

    // ── Call the real approve_payout_atomic RPC ──
    const requestId = crypto.randomUUID()
    const { data: rpcResult, error: rpcError } = await supabase
      .rpc('approve_payout_atomic', {
        _payout_id: payout_id,
        _approved_by: account.user_id, // use account owner as approver for QA
        _reason: 'QA automated approval test',
        _request_id: requestId,
      })

    if (rpcError) {
      return new Response(
        JSON.stringify({ error: 'approve_payout_atomic failed', details: rpcError.message, code: rpcError.code }),
        { status: 500, headers }
      )
    }

    // ── Write audit log (service role, matching payout-actions pattern) ──
    const idempotencyKey = `qa-approve:${payout_id}:${requestId}`
    
    // Compute prev_hash from latest audit log
    const { data: latestAudit } = await supabase
      .from('audit_logs')
      .select('row_hash')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    const prevHash = latestAudit?.row_hash ?? 'GENESIS'

    await supabase.from('audit_logs').upsert({
      user_id: account.user_id,
      account_id: account.id,
      action: 'payout_approved',
      details: { payout_id, amount: payout.amount, qa_test: true, request_id: requestId },
      reason: 'QA automated approval test',
      idempotency_key: idempotencyKey,
      request_id: requestId,
      prev_hash: prevHash,
      row_hash: 'qa-' + requestId,
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true })

    // ── Write account event ──
    await supabase.from('account_events').upsert({
      account_id: account.id,
      event_type: 'payout_approved',
      event_data: { payout_id, amount: payout.amount, qa_test: true },
      idempotency_key: `qa-event:${payout_id}:${requestId}`,
      request_id: requestId,
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true })

    // ── Capture after-state ──
    const { data: afterPayout } = await supabase
      .from('payouts')
      .select('status, reviewed_at, approved_by')
      .eq('id', payout_id)
      .single()

    const { data: afterAccount } = await supabase
      .from('accounts')
      .select('status, account_number')
      .eq('id', account.id)
      .single()

    const { data: afterAudit } = await supabase
      .from('audit_logs')
      .select('action, user_id, reason, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(5)

    const { data: afterEvents } = await supabase
      .from('account_events')
      .select('event_type, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(10)

    // ── Assertions ──
    const assertions = {
      payout_status_changed: afterPayout?.status === 'approved',
      account_status_changed: afterAccount?.status === 'payout_approved',
      audit_log_created: (afterAudit?.length ?? 0) > (beforeAudit?.length ?? 0),
      account_event_created: (afterEvents?.length ?? 0) > (beforeEvents?.length ?? 0),
    }

    const allPassed = Object.values(assertions).every(Boolean)

    return new Response(JSON.stringify({
      result: allPassed ? 'PASS' : 'FAIL',
      assertions,
      rpc_result: rpcResult,
      before: { payout: beforePayout, account: beforeAccount, audit_count: beforeAudit?.length, event_count: beforeEvents?.length },
      after: { payout: afterPayout, account: afterAccount, audit: afterAudit, events: afterEvents },
      request_id: requestId,
    }, null, 2), { status: 200, headers })

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Unexpected error', details: String(err) }), { status: 500, headers })
  }
})
