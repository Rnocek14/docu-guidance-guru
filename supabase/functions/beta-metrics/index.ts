// ============================================================
// Beta Metrics — Real-data calibration panel
//
// Tracks the 4 numbers that matter for re-calibrating the
// treasury model with reality (vs. assumed defaults):
//   1. Payout request rate (requests per active funded-month)
//   2. Funded account median lifespan (days)
//   3. Reset-per-signup ratio
//   4. Pass rate (evaluation → funded)
//
// Read-only. Admin-only. No state changes.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

function median(nums: number[]): number {
  if (!nums.length) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json(401, { error: 'Unauthorized' })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user?.id) return json(401, { error: 'Invalid token' })

    const { data: roleRow } = await supabase
      .from('user_roles').select('role')
      .eq('user_id', userData.user.id).eq('role', 'admin')
      .maybeSingle()
    if (!roleRow) return json(403, { error: 'Admin access required' })

    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const now = Date.now()

    // ── Pull lean datasets (read-only) ──
    const [accountsRes, payoutsRes, resetsRes] = await Promise.all([
      svc.from('accounts').select('id,user_id,status,created_at,passed_at,failed_at,disabled_at,parent_account_id').limit(10000),
      svc.from('payouts').select('id,account_id,status,requested_at,paid_at,amount').limit(10000),
      svc.from('reset_purchases').select('id,account_id,user_id,created_at').limit(10000),
    ])

    if (accountsRes.error) return json(500, { error: 'metrics unavailable' })
    const accounts = accountsRes.data ?? []
    const payouts = payoutsRes.data ?? []
    const resets = resetsRes.data ?? []

    // Distinct signup users = unique user_id across root accounts (no parent)
    const rootAccounts = accounts.filter(a => !a.parent_account_id)
    const distinctSignupUsers = new Set(rootAccounts.map(a => a.user_id)).size

    // ── 1. Pass rate ──
    const fundedAccounts = accounts.filter(a => a.passed_at != null)
    const passRate = accounts.length > 0 ? fundedAccounts.length / accounts.length : 0

    // ── 2. Funded lifespan (days): passed_at → (failed_at | disabled_at | now) ──
    const lifespans = fundedAccounts.map(a => {
      const start = new Date(a.passed_at!).getTime()
      const endRaw = a.failed_at ?? a.disabled_at
      const end = endRaw ? new Date(endRaw).getTime() : now
      return Math.max(0, (end - start) / MS_PER_DAY)
    })
    const medianLifespanDays = median(lifespans)
    const fundedClosed = fundedAccounts.filter(a => a.failed_at || a.disabled_at).length

    // ── 3. Payout request rate (requests per funded-account-month) ──
    const fundedIds = new Set(fundedAccounts.map(a => a.id))
    const fundedMonthsTotal = lifespans.reduce((s, d) => s + d / 30.4375, 0)
    const payoutRequestsOnFunded = payouts.filter(p => fundedIds.has(p.account_id as string)).length
    const payoutRequestRatePerActiveMonth = fundedMonthsTotal > 0
      ? payoutRequestsOnFunded / fundedMonthsTotal
      : 0
    const paidPayouts = payouts.filter(p => p.status === 'paid_confirmed' || p.paid_at != null)
    const avgPaidAmount = paidPayouts.length
      ? paidPayouts.reduce((s, p) => s + Number(p.amount ?? 0), 0) / paidPayouts.length
      : 0

    // ── 4. Reset-per-signup ratio ──
    const resetCount = resets.length
    const resetsPerSignup = distinctSignupUsers > 0 ? resetCount / distinctSignupUsers : 0

    // ── Assumed defaults for delta display (from monte-carlo DEFAULTS) ──
    const assumed = {
      passRate: 0.20,
      payoutRequestRatePerActiveMonth: 0.7 * 0.25, // payoutsPerActiveAccountPerMonth * payoutRequestRate
      resetsPerSignup: 0.6,
      medianLifespanDays: 90,
    }

    const sampleSize = {
      totalAccounts: accounts.length,
      distinctSignupUsers,
      fundedAccounts: fundedAccounts.length,
      fundedClosed,
      totalPayoutRequests: payouts.length,
      totalPaidPayouts: paidPayouts.length,
      totalResets: resetCount,
    }

    const confidence: 'insufficient' | 'low' | 'medium' | 'high' =
      fundedAccounts.length >= 50 ? 'high' :
      fundedAccounts.length >= 20 ? 'medium' :
      fundedAccounts.length >= 5 ? 'low' : 'insufficient'

    return json(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      confidence,
      sampleSize,
      metrics: {
        passRate: { observed: passRate, assumed: assumed.passRate },
        payoutRequestRatePerActiveMonth: {
          observed: payoutRequestRatePerActiveMonth,
          assumed: assumed.payoutRequestRatePerActiveMonth,
        },
        resetsPerSignup: { observed: resetsPerSignup, assumed: assumed.resetsPerSignup },
        medianFundedLifespanDays: { observed: medianLifespanDays, assumed: assumed.medianLifespanDays },
        avgPaidPayoutAmount: avgPaidAmount,
      },
    })
  } catch (err) {
    console.error('beta-metrics error:', err)
    return json(500, { error: 'metrics unavailable' })
  }
})