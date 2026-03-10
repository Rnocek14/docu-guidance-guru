import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { constantTimeEqual } from '../_shared/crypto.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

/**
 * capacity-monitor — Lightweight health & scale readiness endpoint
 *
 * Returns current platform load indicators so operators can see
 * when they're approaching capacity ceilings.
 *
 * AUTH: admin JWT or CRON_SECRET
 */

interface CapacityReport {
  timestamp: string
  accounts: {
    total: number
    active: number
    new_30d: number
    new_7d: number
    monthly_run_rate: number
  }
  trades: {
    total: number
    last_24h: number
    last_7d: number
    daily_run_rate: number
  }
  payouts: {
    pending: number
    in_flight_amount: number
    paid_30d: number
  }
  queues: {
    fulfillment_stuck: number
    flags_pending: number
    fraud_reviews_pending: number
  }
  crons: {
    total_configured: number
    recent_failures: number
    last_run_age_minutes: Record<string, number>
  }
  capacity_signals: {
    level: 'green' | 'yellow' | 'red'
    warnings: string[]
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    let cronSecret = Deno.env.get('CRON_SECRET') ?? ''

    if (!cronSecret || cronSecret.length < 16) {
      const tempClient = createClient(supabaseUrl, serviceKey)
      const { data } = await tempClient
        .from('internal_secrets')
        .select('value')
        .eq('key', 'CRON_SECRET')
        .single()
      cronSecret = data?.value ?? ''
    }

    // Auth gate
    const incomingCron = (req.headers.get('X-Cron-Secret') ?? '').trim()
    const authHeader = req.headers.get('Authorization') ?? ''
    let isAuthorized = false

    if (cronSecret && cronSecret.length >= 16 && incomingCron) {
      isAuthorized = await constantTimeEqual(incomingCron, cronSecret)
    }

    if (!isAuthorized && authHeader.startsWith('Bearer ')) {
      const jwt = authHeader.replace('Bearer ', '')
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      })
      const { data: userData } = await userClient.auth.getUser()
      if (userData?.user) {
        const adminClient = createClient(supabaseUrl, serviceKey)
        const { data: hasAdmin } = await adminClient.rpc('has_role', {
          _user_id: userData.user.id,
          _role: 'admin',
        })
        isAuthorized = hasAdmin === true
      }
    }

    if (!isAuthorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const db = createClient(supabaseUrl, serviceKey)
    const now = new Date()
    const d30 = new Date(now.getTime() - 30 * 86400000).toISOString()
    const d7 = new Date(now.getTime() - 7 * 86400000).toISOString()
    const d24h = new Date(now.getTime() - 86400000).toISOString()

    // Fire all queries in parallel for speed
    const [
      totalAccounts, activeAccounts, new30d, new7d,
      totalTrades, trades24h, trades7d,
      pendingPayouts, inFlightPayouts, paid30d,
      stuckFulfillment, pendingFlags, pendingFraud,
      cronConfigs, recentCronRuns,
    ] = await Promise.all([
      db.from('accounts').select('*', { count: 'exact', head: true }),
      db.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      db.from('accounts').select('*', { count: 'exact', head: true }).gte('created_at', d30),
      db.from('accounts').select('*', { count: 'exact', head: true }).gte('created_at', d7),
      db.from('trades').select('*', { count: 'exact', head: true }),
      db.from('trades').select('*', { count: 'exact', head: true }).gte('created_at', d24h),
      db.from('trades').select('*', { count: 'exact', head: true }).gte('created_at', d7),
      db.from('payouts').select('*', { count: 'exact', head: true }).in('status', ['pending', 'under_review']),
      db.from('payouts').select('amount').in('status', ['pending', 'under_review', 'approved', 'payment_initiated']),
      db.from('payouts').select('*', { count: 'exact', head: true }).in('status', ['paid', 'paid_confirmed']).gte('paid_at', d30),
      db.from('checkout_fulfillment_queue').select('*', { count: 'exact', head: true }).eq('status', 'queued').gt('attempts', 2),
      db.from('flags').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('fraud_reviews').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('cron_health_config').select('jobname, enabled'),
      db.from('cron_http_runs').select('jobname, http_status, ran_at').order('ran_at', { ascending: false }).limit(100),
    ])

    const inFlightAmount = (inFlightPayouts.data ?? []).reduce((s, p) => s + Number(p.amount || 0), 0)
    const monthlyRunRate = Math.round(((new30d.count ?? 0) / 30) * 30)
    const dailyTradeRate = Math.round((trades7d.count ?? 0) / 7)

    // Compute last run age per cron job
    const lastRunAge: Record<string, number> = {}
    const recentFailures = (recentCronRuns.data ?? []).filter(r => r.http_status !== 200).length

    for (const config of (cronConfigs.data ?? [])) {
      if (!config.enabled) continue
      const lastRun = (recentCronRuns.data ?? []).find(r => r.jobname === config.jobname)
      if (lastRun) {
        lastRunAge[config.jobname] = Math.round((now.getTime() - new Date(lastRun.ran_at).getTime()) / 60000)
      } else {
        lastRunAge[config.jobname] = -1 // never ran
      }
    }

    // Capacity signals
    const warnings: string[] = []
    const activeCount = activeAccounts.count ?? 0
    const stuckCount = stuckFulfillment.count ?? 0

    if (monthlyRunRate > 400) warnings.push(`Monthly account run rate ${monthlyRunRate} approaching 500 solo ceiling`)
    if (monthlyRunRate > 700) warnings.push(`Monthly account run rate ${monthlyRunRate} exceeds safe solo capacity`)
    if (dailyTradeRate > 500) warnings.push(`Daily trade rate ${dailyTradeRate} — monitor ingestion latency`)
    if (stuckCount > 0) warnings.push(`${stuckCount} stuck fulfillment queue items`)
    if (recentFailures > 5) warnings.push(`${recentFailures} cron failures in recent runs`)
    if ((pendingFlags.count ?? 0) > 10) warnings.push(`${pendingFlags.count} pending flags in queue`)

    // Check for cron jobs that haven't run
    for (const [job, age] of Object.entries(lastRunAge)) {
      if (age === -1) warnings.push(`Cron '${job}' has never run`)
      else if (age > 180) warnings.push(`Cron '${job}' last ran ${age}min ago`)
    }

    const level = warnings.some(w => w.includes('exceeds') || w.includes('stuck') || w.includes('never ran'))
      ? 'red'
      : warnings.length > 0
      ? 'yellow'
      : 'green'

    const report: CapacityReport = {
      timestamp: now.toISOString(),
      accounts: {
        total: totalAccounts.count ?? 0,
        active: activeCount,
        new_30d: new30d.count ?? 0,
        new_7d: new7d.count ?? 0,
        monthly_run_rate: monthlyRunRate,
      },
      trades: {
        total: totalTrades.count ?? 0,
        last_24h: trades24h.count ?? 0,
        last_7d: trades7d.count ?? 0,
        daily_run_rate: dailyTradeRate,
      },
      payouts: {
        pending: pendingPayouts.count ?? 0,
        in_flight_amount: Math.round(inFlightAmount),
        paid_30d: paid30d.count ?? 0,
      },
      queues: {
        fulfillment_stuck: stuckCount,
        flags_pending: pendingFlags.count ?? 0,
        fraud_reviews_pending: pendingFraud.count ?? 0,
      },
      crons: {
        total_configured: (cronConfigs.data ?? []).filter((c: { enabled: boolean }) => c.enabled).length,
        recent_failures: recentFailures,
        last_run_age_minutes: lastRunAge,
      },
      capacity_signals: { level, warnings },
    }

    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('capacity-monitor error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
