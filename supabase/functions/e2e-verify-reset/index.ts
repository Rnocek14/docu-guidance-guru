// One-shot E2E verification for the reset flow.
// Runs against live DB via service-role; cleans up all created rows on exit.
// Gated by X-E2E-Secret header to prevent accidental invocation.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-e2e-secret',
}

type Step = { name: string; ok: boolean; detail?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const secret = Deno.env.get('E2E_VERIFY_SECRET') ?? 'meridian-reset-e2e'
  if (req.headers.get('x-e2e-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const steps: Step[] = []
  const log = (name: string, ok: boolean, detail?: string) => {
    steps.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  const assert = (name: string, cond: boolean, detail = '') => {
    log(name, !!cond, detail)
    if (!cond) throw new Error(`ASSERT_FAILED:${name}:${detail}`)
  }

  const createdAccounts: string[] = []
  const createdPurchases: string[] = []
  const createdAuditKeys: string[] = []
  const createdEventKeys: string[] = []

  try {
    // Pick any active cohort
    const { data: cohort } = await supabase
      .from('cohorts').select('id').eq('is_active', true).limit(1).single()
    if (!cohort) throw new Error('no active cohort')

    const userId = crypto.randomUUID()
    const acctId = crypto.randomUUID()
    createdAccounts.push(acctId)

    // Seed breached account
    {
      const { error } = await supabase.from('accounts').insert({
        id: acctId,
        user_id: userId,
        cohort_id: cohort.id,
        account_number: `E2E-${acctId.slice(0, 8)}`,
        status: 'breached_detected',
        starting_balance: 50000,
        current_balance: 47000,
        highest_balance: 51000,
        daily_pnl: -3000,
        daily_pnl_start_balance: 50000,
        payout_cycle_start_balance: 50000,
        payout_cycle_started_at: new Date(Date.now() - 5 * 86400_000).toISOString(),
        total_pnl: -3000,
        trading_days_count: 7,
        failed_at: new Date().toISOString(),
        provider: 'stripe',
        provider_session_id: `cs_e2e_${acctId}`,
      })
      if (error) throw new Error('seed account: ' + error.message)
    }

    const insertPurchase = async (bundle: 'single'|'urgency_single'|'three_pack', amt: number, total: number, urgency: boolean) => {
      const id = crypto.randomUUID()
      createdPurchases.push(id)
      createdAuditKeys.push(`reset_applied:${id}`)
      createdEventKeys.push(`reset_applied_evt:${id}`)
      const { error } = await supabase.from('reset_purchases').insert({
        id, user_id: userId, account_id: acctId, bundle_id: bundle,
        resets_total: total, resets_remaining: total,
        amount_paid_cents: amt, urgency_window_active: urgency,
        provider: 'stripe', provider_session_id: `cs_${id}`, status: 'pending',
      })
      if (error) throw new Error('insert purchase: ' + error.message)
      return id
    }

    const fetchAccount = async () => {
      const { data, error } = await supabase.from('accounts').select('*').eq('id', acctId).single()
      if (error) throw new Error('fetch account: ' + error.message)
      return data!
    }

    // ── TEST 1: Normal breach reset ────────────────────────────
    const p1 = await insertPurchase('urgency_single', 7900, 1, true)
    const { data: r1, error: e1 } = await supabase.rpc('apply_reset_from_purchase', {
      p_purchase_id: p1, p_provider_event_id: 'evt_t1',
    })
    if (e1) throw new Error('T1 rpc: ' + e1.message)
    let a = await fetchAccount()
    assert('T1.status=active', a.status === 'active', a.status)
    assert('T1.balance=50000', Number(a.current_balance) === 50000, String(a.current_balance))
    assert('T1.highest=50000', Number(a.highest_balance) === 50000)
    assert('T1.daily_pnl=0', Number(a.daily_pnl) === 0)
    assert('T1.daily_pnl_start=50000', Number(a.daily_pnl_start_balance) === 50000)
    assert('T1.payout_cycle_balance=50000', Number(a.payout_cycle_start_balance) === 50000)
    assert('T1.failed_at cleared', a.failed_at === null)
    assert('T1.last_reset_at set', !!a.last_reset_at)
    assert('T1.credits_remaining=0', a.reset_credits_remaining === 0)
    assert('T1.restored_account=true', (r1 as any)?.restored_account === true)

    // ── TEST 2: Idempotent replay ──────────────────────────────
    const { data: r2 } = await supabase.rpc('apply_reset_from_purchase', {
      p_purchase_id: p1, p_provider_event_id: 'evt_t1_REPLAY',
    })
    assert('T2.idempotent=true', (r2 as any)?.idempotent === true)
    a = await fetchAccount()
    assert('T2.no phantom credits', a.reset_credits_remaining === 0)
    assert('T2.balance unchanged', Number(a.current_balance) === 50000)

    const { count: audit1 } = await supabase.from('audit_logs').select('id', { count: 'exact', head: true })
      .eq('idempotency_key', `reset_applied:${p1}`)
    assert('T2.audit_logs row count=1', audit1 === 1, `got ${audit1}`)
    const { count: ev1 } = await supabase.from('account_events').select('id', { count: 'exact', head: true })
      .eq('idempotency_key', `reset_applied_evt:${p1}`)
    assert('T2.account_events count=1', ev1 === 1, `got ${ev1}`)

    // ── TEST 3: Bundle banking on active account, then consume ──
    const p2 = await insertPurchase('three_pack', 19900, 3, false)
    const { data: r3 } = await supabase.rpc('apply_reset_from_purchase', {
      p_purchase_id: p2, p_provider_event_id: 'evt_t3',
    })
    a = await fetchAccount()
    assert('T3a.credits=3', a.reset_credits_remaining === 3, String(a.reset_credits_remaining))
    assert('T3a.status=active', a.status === 'active')
    assert('T3a.restored=false', (r3 as any)?.restored_account === false)

    // Force breach + consume
    await supabase.from('accounts').update({
      status: 'breached_detected', current_balance: 46000,
      daily_pnl: -4000, failed_at: new Date().toISOString(),
    }).eq('id', acctId)
    const { data: consumed1 } = await supabase.rpc('consume_reset_credit_if_breached', { p_account_id: acctId })
    assert('T3b.consume returned true', consumed1 === true)
    a = await fetchAccount()
    assert('T3b.status=active', a.status === 'active')
    assert('T3b.balance restored', Number(a.current_balance) === 50000)
    assert('T3b.credits=2', a.reset_credits_remaining === 2, String(a.reset_credits_remaining))
    assert('T3b.failed_at cleared', a.failed_at === null)

    // Consume noop on active account
    const { data: consumed2 } = await supabase.rpc('consume_reset_credit_if_breached', { p_account_id: acctId })
    assert('T3c.consume noop', consumed2 === false)
    a = await fetchAccount()
    assert('T3c.credits unchanged=2', a.reset_credits_remaining === 2)

    // ── TEST 4: Concurrency contract — two near-simultaneous applies ──
    await supabase.from('accounts').update({
      status: 'breached_detected', current_balance: 45000, failed_at: new Date().toISOString(),
    }).eq('id', acctId)
    const p3 = await insertPurchase('single', 9900, 1, false)
    const [r4a, r4b] = await Promise.all([
      supabase.rpc('apply_reset_from_purchase', { p_purchase_id: p3, p_provider_event_id: 'evt_t4a' }),
      supabase.rpc('apply_reset_from_purchase', { p_purchase_id: p3, p_provider_event_id: 'evt_t4b' }),
    ])
    const restored = [(r4a.data as any), (r4b.data as any)]
    const restoredCount = restored.filter(r => r?.restored_account === true).length
    const idempCount = restored.filter(r => r?.idempotent === true).length
    assert('T4.exactly one winner restored', restoredCount === 1, JSON.stringify(restored))
    assert('T4.exactly one idempotent short-circuit', idempCount === 1)
    a = await fetchAccount()
    assert('T4.credits still=2 (no leak)', a.reset_credits_remaining === 2, String(a.reset_credits_remaining))
    assert('T4.balance restored once', Number(a.current_balance) === 50000)

    // ── TEST 5: Payout-cycle integrity ─────────────────────────
    assert('T5.cycle balance reset', Number(a.payout_cycle_start_balance) === 50000)
    assert('T5.cycle started recently', Date.now() - new Date(a.payout_cycle_started_at).getTime() < 60_000)
    assert('T5.no stale highwater', Number(a.highest_balance) === 50000)
    assert('T5.daily_pnl_start reset', Number(a.daily_pnl_start_balance) === 50000)

    // ── TEST 6: Audit integrity ───────────────────────────────
    const { data: audits } = await supabase.from('audit_logs')
      .select('id,row_hash,idempotency_key').eq('account_id', acctId)
    const cnt = audits?.length ?? 0
    assert('T6.audit rows >=4', cnt >= 4, `got ${cnt}`)
    const badHash = (audits ?? []).find(r => !r.row_hash || r.row_hash.length !== 64)
    assert('T6.all hashes 64 chars', !badHash, badHash ? JSON.stringify(badHash) : '')
    const { count: evts } = await supabase.from('account_events')
      .select('id', { count: 'exact', head: true }).eq('account_id', acctId)
    assert('T6.account_events >=3', (evts ?? 0) >= 3, `got ${evts}`)

    return new Response(JSON.stringify({ ok: true, passed: steps.length, steps }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false, error: (err as Error).message, steps,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } finally {
    // ── Cleanup ──
    try {
      if (createdAuditKeys.length) {
        // audit_logs has no delete policy from client; service role bypasses RLS but
        // there may be a no-delete RLS. Service role bypasses ALL RLS, including these.
        await supabase.from('audit_logs').delete().in('idempotency_key', createdAuditKeys)
      }
      if (createdEventKeys.length) {
        await supabase.from('account_events').delete().in('idempotency_key', createdEventKeys)
      }
      // Credit-consume row uses a timestamp suffix; nuke by account
      for (const aid of createdAccounts) {
        await supabase.from('audit_logs').delete().eq('account_id', aid)
        await supabase.from('account_events').delete().eq('account_id', aid)
      }
      if (createdPurchases.length) {
        await supabase.from('reset_purchases').delete().in('id', createdPurchases)
      }
      if (createdAccounts.length) {
        await supabase.from('accounts').delete().in('id', createdAccounts)
      }
    } catch (cleanupErr) {
      console.error('cleanup error:', (cleanupErr as Error).message)
    }
  }
})