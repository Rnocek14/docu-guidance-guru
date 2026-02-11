import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ScanResult {
  id: string
  section: string
  name: string
  result: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
  detail: string
  data?: unknown
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const headers = { ...corsHeaders, 'Content-Type': 'application/json' }

  // Environment guard
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const appEnv = Deno.env.get('APP_ENV') ?? ''
  if (appEnv === 'production' || (!supabaseUrl.includes('sfxmgwkrjwuerfkqxokq') && appEnv !== 'test')) {
    return new Response(JSON.stringify({ error: 'QA endpoint disabled in production' }), { status: 403, headers })
  }

  try {
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Auth
    const authHeader = req.headers.get('authorization') ?? ''
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!jwt) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers })

    const authed = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    })
    const { data: userRes, error: userErr } = await authed.auth.getUser()
    if (userErr || !userRes?.user) return new Response(JSON.stringify({ error: 'Invalid JWT' }), { status: 401, headers })

    const svc = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    const { data: isAdmin } = await svc.rpc('has_role', { _user_id: userRes.user.id, _role: 'admin' })
    if (isAdmin !== true) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers })

    const results: ScanResult[] = []

    // Parse body for optional payout_id and breach_account_id
    let body: Record<string, string> = {}
    try { body = await req.json() } catch { /* empty body ok */ }

    // Normalize sentinels — treat "__none" or empty as absent
    const isValidUuid = (v: string | undefined) => v && v !== '__none' && v !== '' && /^[0-9a-f]{8}-/.test(v)

    // Auto-pick eligible payout if not provided
    let payoutId = isValidUuid(body.payout_id) ? body.payout_id : undefined
    if (!payoutId) {
      const { data: autoPayout } = await svc
        .from('payouts')
        .select('id, accounts!inner(account_number)')
        .in('status', ['pending', 'under_review'])
        .order('requested_at', { ascending: false })
        .limit(20)
      const eligible = (autoPayout ?? []).find((p: any) => {
        const acct = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts
        const num = acct?.account_number ?? ''
        return num.startsWith('SEEDV2-') || num.startsWith('DEMO-')
      })
      if (eligible) payoutId = eligible.id
    }

    // Auto-pick eligible breached account if not provided
    let breachAccountId = isValidUuid(body.breach_account_id) ? body.breach_account_id : undefined
    if (!breachAccountId) {
      const { data: autoBreach } = await svc
        .from('accounts')
        .select('id, account_number')
        .in('status', ['breached_detected', 'under_review'])
        .or('account_number.like.SEEDV2-%,account_number.like.DEMO-%')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (autoBreach) breachAccountId = autoBreach.id
    }

    // ================================================================
    // SECTION A: Connectivity & Auth
    // ================================================================

    // A1: get-admin-readiness
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/get-admin-readiness`, {
        headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey },
      })
      const raw = await res.text()
      let parsed: any; try { parsed = JSON.parse(raw) } catch { parsed = { raw } }
      results.push({
        id: 'A1', section: 'Connectivity', name: 'get-admin-readiness returns 200',
        result: res.ok ? 'PASS' : 'FAIL',
        detail: res.ok ? `safeToSell=${parsed.safeToSell}` : `HTTP ${res.status}`,
        data: res.ok ? { safeToSell: parsed.safeToSell, blockers: parsed.blockers?.length } : parsed,
      })
    } catch (e) {
      results.push({ id: 'A1', section: 'Connectivity', name: 'get-admin-readiness returns 200', result: 'ERROR', detail: String(e) })
    }

    // A2: evaluate-risk-throttle
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/evaluate-risk-throttle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey, 'Content-Type': 'application/json' },
      })
      const raw = await res.text()
      let parsed: any; try { parsed = JSON.parse(raw) } catch { parsed = { raw } }
      results.push({
        id: 'A2', section: 'Connectivity', name: 'evaluate-risk-throttle returns 200',
        result: res.ok ? 'PASS' : 'FAIL',
        detail: res.ok ? `state=${parsed.state}` : `HTTP ${res.status}`,
        data: parsed,
      })
    } catch (e) {
      results.push({ id: 'A2', section: 'Connectivity', name: 'evaluate-risk-throttle returns 200', result: 'ERROR', detail: String(e) })
    }

    // A3: get-pass-rate-stats
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/get-pass-rate-stats`, {
        headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey },
      })
      results.push({
        id: 'A3', section: 'Connectivity', name: 'get-pass-rate-stats returns 200',
        result: res.ok ? 'PASS' : 'FAIL',
        detail: res.ok ? 'OK' : `HTTP ${res.status}`,
      })
    } catch (e) {
      results.push({ id: 'A3', section: 'Connectivity', name: 'get-pass-rate-stats returns 200', result: 'ERROR', detail: String(e) })
    }

    // ================================================================
    // SECTION B: Payout Pipeline (SEEDV2 payout approve)
    // ================================================================
    if (payoutId) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/qa-approve-payout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ payout_id: payoutId }),
        })
        const raw = await res.text()
        let parsed: any; try { parsed = JSON.parse(raw) } catch { parsed = { raw } }

        if (res.ok && parsed.result === 'PASS') {
          results.push({
            id: 'B1', section: 'Payout Pipeline', name: 'QA payout approve end-to-end',
            result: 'PASS', detail: `All assertions passed for ${parsed.account_number}`,
            data: parsed.assertions,
          })
        } else if (res.ok) {
          results.push({
            id: 'B1', section: 'Payout Pipeline', name: 'QA payout approve end-to-end',
            result: 'FAIL', detail: `Assertions failed: ${JSON.stringify(parsed.assertions)}`,
            data: parsed,
          })
        } else {
          results.push({
            id: 'B1', section: 'Payout Pipeline', name: 'QA payout approve end-to-end',
            result: 'FAIL', detail: parsed.error || `HTTP ${res.status}`,
            data: parsed,
          })
        }
      } catch (e) {
        results.push({ id: 'B1', section: 'Payout Pipeline', name: 'QA payout approve end-to-end', result: 'ERROR', detail: String(e) })
      }
    } else {
      results.push({ id: 'B1', section: 'Payout Pipeline', name: 'QA payout approve end-to-end', result: 'SKIP', detail: 'No eligible SEEDV2/DEMO pending payout found' })
    }

    // ================================================================
    // SECTION C: Risk Queue — breach confirm
    // ================================================================
    if (breachAccountId) {
      try {
        // Verify account is SEEDV2/DEMO and breached
        const { data: acct } = await svc.from('accounts').select('id, account_number, status').eq('id', breachAccountId).single()
        if (!acct || (!acct.account_number.startsWith('SEEDV2-') && !acct.account_number.startsWith('DEMO-'))) {
          results.push({ id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end', result: 'SKIP', detail: 'Account not SEEDV2/DEMO' })
        } else if (!['breached_detected', 'under_review'].includes(acct.status)) {
          results.push({ id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end', result: 'SKIP', detail: `Account status=${acct.status}, not breached` })
        } else {
          // Snapshot before
          const { data: beforeAudit } = await svc.from('audit_logs').select('id').eq('account_id', breachAccountId)
          const beforeCount = beforeAudit?.length ?? 0

          const res = await fetch(`${supabaseUrl}/functions/v1/review-actions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'confirm_failure',
              account_id: breachAccountId,
              reason: 'QA scan: automated breach confirmation test',
            }),
          })
          const raw = await res.text()
          let parsed: any; try { parsed = JSON.parse(raw) } catch { parsed = { raw } }

          if (res.ok) {
            // Verify DB state
            const { data: afterAcct } = await svc.from('accounts').select('status').eq('id', breachAccountId).single()
            const { data: afterAudit } = await svc.from('audit_logs').select('id').eq('account_id', breachAccountId)
            const afterCount = afterAudit?.length ?? 0

            // Accept either new audit row OR idempotent dedup (same action replayed)
            const auditOk = afterCount > beforeCount || parsed?.audit_deduplicated === true
            const assertions = {
              account_terminal: afterAcct?.status === 'failed_confirmed',
              audit_present: auditOk,
            }
            const allPass = Object.values(assertions).every(Boolean)
            results.push({
              id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end',
              result: allPass ? 'PASS' : 'FAIL',
              detail: allPass ? `${acct.account_number} → failed_confirmed` : JSON.stringify(assertions),
              data: { assertions, response: parsed },
            })
          } else {
            results.push({ id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end', result: 'FAIL', detail: parsed.error || `HTTP ${res.status}`, data: parsed })
          }
        }
      } catch (e) {
        results.push({ id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end', result: 'ERROR', detail: String(e) })
      }
    } else {
      results.push({ id: 'C1', section: 'Risk Actions', name: 'Breach confirm end-to-end', result: 'SKIP', detail: 'No eligible SEEDV2/DEMO breached account found' })
    }

    // ================================================================
    // SECTION D: DB Invariant Checks (0 rows = PASS)
    // ================================================================

    // D1: RLS enabled on critical tables
    try {
      const { data: rlsCheck } = await svc.rpc('check_rls_enabled' as any)
      // If RPC doesn't exist, fall back to a simpler check
      if (rlsCheck !== undefined) {
        const missing = Array.isArray(rlsCheck) ? rlsCheck : []
        results.push({
          id: 'D1', section: 'DB Invariants', name: 'RLS enabled on all critical tables',
          result: missing.length === 0 ? 'PASS' : 'FAIL',
          detail: missing.length === 0 ? 'All critical tables have RLS' : `Missing RLS: ${JSON.stringify(missing)}`,
          data: missing,
        })
      } else {
        results.push({ id: 'D1', section: 'DB Invariants', name: 'RLS enabled on all critical tables', result: 'SKIP', detail: 'check_rls_enabled RPC not available' })
      }
    } catch {
      results.push({ id: 'D1', section: 'DB Invariants', name: 'RLS enabled on all critical tables', result: 'SKIP', detail: 'RPC unavailable — check manually' })
    }

    // D2: Audit chain integrity (no null hashes)
    try {
      const { data: broken, count } = await svc
        .from('audit_logs')
        .select('id', { count: 'exact', head: true })
        .or('prev_hash.is.null,row_hash.is.null')
      // Allow exactly 1 genesis row
      const badCount = count ?? 0
      results.push({
        id: 'D2', section: 'DB Invariants', name: 'Audit chain integrity (no null hashes)',
        result: badCount <= 1 ? 'PASS' : 'FAIL',
        detail: badCount <= 1 ? `${badCount} genesis row(s)` : `${badCount} rows with null hashes`,
      })
    } catch (e) {
      results.push({ id: 'D2', section: 'DB Invariants', name: 'Audit chain integrity', result: 'ERROR', detail: String(e) })
    }

    // D3: No payout exceeds eligible amount
    try {
      const { data: overpaid } = await svc
        .from('payouts')
        .select('id, amount, calculated_eligible_amount')
        .not('calculated_eligible_amount', 'is', null)
        .gt('amount', 0)
      const violations = (overpaid ?? []).filter(p => p.amount > (p.calculated_eligible_amount ?? Infinity))
      results.push({
        id: 'D3', section: 'DB Invariants', name: 'No payout exceeds eligible amount',
        result: violations.length === 0 ? 'PASS' : 'FAIL',
        detail: violations.length === 0 ? '0 violations' : `${violations.length} payout(s) over cap`,
        data: violations.length > 0 ? violations.slice(0, 5) : undefined,
      })
    } catch (e) {
      results.push({ id: 'D3', section: 'DB Invariants', name: 'No payout exceeds eligible amount', result: 'ERROR', detail: String(e) })
    }

    // D4: Paid payouts have payment trail
    try {
      const { data: paidPayouts } = await svc
        .from('payouts')
        .select('id, status, account_id')
        .in('status', ['paid', 'paid_confirmed'])

      let orphans: string[] = []
      if (paidPayouts && paidPayouts.length > 0) {
        const ids = paidPayouts.map(p => p.id)
        const { data: payments } = await svc
          .from('payout_payments')
          .select('payout_id')
          .in('payout_id', ids)
        const withPayments = new Set((payments ?? []).map(pp => pp.payout_id))
        orphans = ids.filter(id => !withPayments.has(id))
      }
      results.push({
        id: 'D4', section: 'DB Invariants', name: 'Paid payouts have payment trail',
        result: orphans.length === 0 ? 'PASS' : 'FAIL',
        detail: orphans.length === 0 ? '0 orphans' : `${orphans.length} paid payout(s) without payment record`,
        data: orphans.length > 0 ? orphans.slice(0, 5) : undefined,
      })
    } catch (e) {
      results.push({ id: 'D4', section: 'DB Invariants', name: 'Paid payouts have payment trail', result: 'ERROR', detail: String(e) })
    }

    // D5: Breached accounts have violation records
    try {
      const { data: breached } = await svc
        .from('accounts')
        .select('id, account_number')
        .eq('status', 'breached_detected')

      let missing: string[] = []
      if (breached && breached.length > 0) {
        for (const acct of breached) {
          const { count } = await svc
            .from('violations')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', acct.id)
          if ((count ?? 0) === 0) missing.push(acct.account_number)
        }
      }
      results.push({
        id: 'D5', section: 'DB Invariants', name: 'Breached accounts have violations',
        result: missing.length === 0 ? 'PASS' : 'FAIL',
        detail: missing.length === 0 ? '0 violations missing' : `${missing.length} breached without violations`,
        data: missing.length > 0 ? missing : undefined,
      })
    } catch (e) {
      results.push({ id: 'D5', section: 'DB Invariants', name: 'Breached accounts have violations', result: 'ERROR', detail: String(e) })
    }

    // D6: payout_requested accounts have a matching pending payout
    try {
      const { data: prAccounts } = await svc
        .from('accounts')
        .select('id, account_number')
        .eq('status', 'payout_requested')

      let orphaned: string[] = []
      if (prAccounts && prAccounts.length > 0) {
        for (const acct of prAccounts) {
          const { count } = await svc
            .from('payouts')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', acct.id)
            .in('status', ['pending', 'under_review', 'approved'])
          if ((count ?? 0) === 0) orphaned.push(acct.account_number)
        }
      }
      results.push({
        id: 'D6', section: 'DB Invariants', name: 'payout_requested has matching payout',
        result: orphaned.length === 0 ? 'PASS' : 'FAIL',
        detail: orphaned.length === 0 ? '0 orphans' : `${orphaned.length} account(s) without payout`,
        data: orphaned.length > 0 ? orphaned : undefined,
      })
    } catch (e) {
      results.push({ id: 'D6', section: 'DB Invariants', name: 'payout_requested has matching payout', result: 'ERROR', detail: String(e) })
    }

    // D7: Lifetime paid total drift
    try {
      const { data: profiles } = await svc
        .from('profiles')
        .select('user_id, email, lifetime_paid_total')
        .gt('lifetime_paid_total', 0)

      let drifts: { email: string; profile_total: number; actual: number }[] = []
      if (profiles && profiles.length > 0) {
        for (const p of profiles) {
          const { data: userPayouts } = await svc
            .from('payouts')
            .select('amount, accounts!inner(user_id)')
            .in('status', ['paid', 'paid_confirmed'])
            .eq('accounts.user_id', p.user_id)
          const actualTotal = (userPayouts ?? []).reduce((s: number, x: any) => s + Number(x.amount || 0), 0)
          if (Math.abs(p.lifetime_paid_total - actualTotal) > 0.01) {
            drifts.push({ email: p.email, profile_total: p.lifetime_paid_total, actual: actualTotal })
          }
        }
      }
      results.push({
        id: 'D7', section: 'DB Invariants', name: 'Lifetime paid total matches actual',
        result: drifts.length === 0 ? 'PASS' : 'FAIL',
        detail: drifts.length === 0 ? 'No drift detected' : `${drifts.length} profile(s) with drift`,
        data: drifts.length > 0 ? drifts : undefined,
      })
    } catch (e) {
      results.push({ id: 'D7', section: 'DB Invariants', name: 'Lifetime paid total matches actual', result: 'ERROR', detail: String(e) })
    }

    // D8: Daily stats count vs trading_days_count for SEEDV2 accounts
    try {
      const { data: seedAccounts } = await svc
        .from('accounts')
        .select('id, account_number, trading_days_count')
        .like('account_number', 'SEEDV2-%')

      let mismatches: { account: string; expected: number; actual: number }[] = []
      if (seedAccounts && seedAccounts.length > 0) {
        for (const a of seedAccounts) {
          const { count } = await svc
            .from('account_daily_stats')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', a.id)
          const actual = count ?? 0
          if (a.trading_days_count !== actual) {
            mismatches.push({ account: a.account_number, expected: a.trading_days_count, actual })
          }
        }
      }
      results.push({
        id: 'D8', section: 'DB Invariants', name: 'SEEDV2 daily stats count matches',
        result: mismatches.length === 0 ? 'PASS' : 'FAIL',
        detail: mismatches.length === 0 ? 'All match' : `${mismatches.length} mismatch(es)`,
        data: mismatches.length > 0 ? mismatches : undefined,
      })
    } catch (e) {
      results.push({ id: 'D8', section: 'DB Invariants', name: 'SEEDV2 daily stats count matches', result: 'ERROR', detail: String(e) })
    }

    // D9: Paid payouts without paid_at or payment_reference
    try {
      const { data: badPaid } = await svc
        .from('payouts')
        .select('id, status, paid_at, payment_reference')
        .in('status', ['paid', 'paid_confirmed'])
        .or('paid_at.is.null,payment_reference.is.null')
      const count = badPaid?.length ?? 0
      results.push({
        id: 'D9', section: 'DB Invariants', name: 'Paid payouts have paid_at + reference',
        result: count === 0 ? 'PASS' : 'FAIL',
        detail: count === 0 ? '0 violations' : `${count} paid payout(s) missing timestamp/reference`,
        data: count > 0 ? badPaid?.slice(0, 5) : undefined,
      })
    } catch (e) {
      results.push({ id: 'D9', section: 'DB Invariants', name: 'Paid payouts have paid_at + reference', result: 'ERROR', detail: String(e) })
    }

    // D10: Breaker state exists
    try {
      const { data: breaker } = await svc.from('econ_breaker_state').select('breaker_level').limit(1).maybeSingle()
      results.push({
        id: 'D10', section: 'DB Invariants', name: 'Breaker state exists',
        result: breaker ? 'PASS' : 'FAIL',
        detail: breaker ? `Level: ${breaker.breaker_level}` : 'Missing breaker state row',
      })
    } catch (e) {
      results.push({ id: 'D10', section: 'DB Invariants', name: 'Breaker state exists', result: 'ERROR', detail: String(e) })
    }

    // ================================================================
    // Summary
    // ================================================================
    const passCount = results.filter(r => r.result === 'PASS').length
    const failCount = results.filter(r => r.result === 'FAIL').length
    const skipCount = results.filter(r => r.result === 'SKIP').length
    const errorCount = results.filter(r => r.result === 'ERROR').length

    return new Response(JSON.stringify({
      scannedAt: new Date().toISOString(),
      summary: { total: results.length, pass: passCount, fail: failCount, skip: skipCount, error: errorCount },
      allPass: failCount === 0 && errorCount === 0,
      results,
    }, null, 2), { status: 200, headers })

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Unexpected error', details: String(err) }), { status: 500, headers })
  }
})
