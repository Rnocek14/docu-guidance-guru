import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

/**
 * Daily Risk Snapshot Edge Function
 * 
 * Collects pass rate, simulation freshness, reserve status, and pending payouts
 * into a single risk_snapshots row. Triggers alarms if thresholds exceeded.
 * 
 * Designed to be called by pg_cron or manually by admin/risk staff.
 */

interface Alarm {
  code: string
  level: 'warning' | 'elevated' | 'high' | 'critical'
  message: string
  value?: number
  threshold?: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // Auth: allow service-role calls (cron) or admin/risk_officer JWT calls
    const authHeader = req.headers.get('Authorization')
    let userId: string | null = null

    if (authHeader?.startsWith('Bearer ')) {
      const jwt = authHeader.replace('Bearer ', '')
      // Check if it's the anon key (cron call) - skip user auth
      if (jwt !== anonKey) {
        const anonClient = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${jwt}` } },
        })
        const { data: userData, error: userError } = await anonClient.auth.getUser()
        if (userError || !userData?.user) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        userId = userData.user.id

        const serviceClient = createClient(supabaseUrl, serviceKey)
        const { data: isAdmin } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'admin' })
        const { data: isRisk } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'risk_officer' })
        if (isAdmin !== true && isRisk !== true) {
          return new Response(
            JSON.stringify({ error: 'Forbidden: admin or risk_officer required' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
    }

    const db = createClient(supabaseUrl, serviceKey)
    const alarms: Alarm[] = []

    // 1. Pass rate
    const { data: passRateData } = await db.rpc('get_rolling_pass_rate', { _window_days: 30 })
    const passRate = passRateData?.pass_rate ?? null
    const passRateAlertLevel = passRateData?.alert_level ?? null
    const totalAccounts = passRateData?.total_accounts ?? null
    const passedAccounts = passRateData?.passed_accounts ?? null

    if (passRate !== null && passRate > 0.15) {
      const level = passRate > 0.18 ? 'critical' : passRate > 0.17 ? 'high' : passRate > 0.16 ? 'elevated' : 'warning'
      alarms.push({
        code: 'PASS_RATE_ELEVATED',
        level,
        message: `30-day pass rate is ${(passRate * 100).toFixed(1)}% (threshold: 15%)`,
        value: passRate,
        threshold: 0.15,
      })
    }

    // 2. Simulation freshness
    const { data: reserveConfig } = await db
      .from('system_settings')
      .select('value')
      .eq('key', 'reserve_aware_approval')
      .single()

    const config = reserveConfig?.value as { last_simulation_run_id?: string } | null
    let simulationRunId: string | null = null
    let simulationStale = true
    let simulationAgeHours: number | null = null
    let reserveBreachProb: number | null = null
    let annualLossProb: number | null = null
    let worstMonth: number | null = null

    if (config?.last_simulation_run_id) {
      simulationRunId = config.last_simulation_run_id
      const { data: simRun } = await db
        .from('simulation_runs')
        .select('id, created_at, probability_of_loss, reserve_breach_probability, worst_month')
        .eq('id', simulationRunId)
        .single()

      if (simRun) {
        const ageMs = Date.now() - new Date(simRun.created_at).getTime()
        simulationAgeHours = Math.round(ageMs / (60 * 60 * 1000) * 10) / 10
        simulationStale = ageMs > 7 * 24 * 60 * 60 * 1000 // 7 days
        reserveBreachProb = Number(simRun.reserve_breach_probability) || null
        annualLossProb = Number(simRun.probability_of_loss) || null
        worstMonth = Number(simRun.worst_month) || null

        if (simulationStale) {
          alarms.push({
            code: 'SIMULATION_STALE',
            level: 'high',
            message: `Last simulation is ${Math.round(simulationAgeHours / 24)} days old (max 7)`,
            value: simulationAgeHours,
            threshold: 168,
          })
        }

        if (reserveBreachProb !== null && reserveBreachProb > 0.02) {
          alarms.push({
            code: 'RESERVE_BREACH_RISK',
            level: reserveBreachProb > 0.05 ? 'critical' : 'elevated',
            message: `Reserve breach probability is ${(reserveBreachProb * 100).toFixed(1)}%`,
            value: reserveBreachProb,
            threshold: 0.02,
          })
        }
      } else {
        alarms.push({
          code: 'SIMULATION_MISSING',
          level: 'critical',
          message: `Referenced simulation run ${simulationRunId} not found`,
        })
      }
    } else {
      alarms.push({
        code: 'NO_SIMULATION_LINKED',
        level: 'high',
        message: 'No simulation run linked to reserve gate',
      })
    }

    // 3. Liability snapshot
    let netBuffer: number | null = null
    const { data: liabilityData } = await db.rpc('get_liability_snapshot', {})
    if (liabilityData) {
      netBuffer = (liabilityData as { net_buffer?: number }).net_buffer ?? null
    }

    // 4. Pending payouts
    const { data: pendingPayouts, count: pendingCount } = await db
      .from('payouts')
      .select('amount', { count: 'exact' })
      .in('status', ['pending', 'under_review', 'approved'])

    const pendingPayoutsCount = pendingCount ?? 0
    const pendingPayoutsAmount = (pendingPayouts ?? []).reduce((s, p) => s + Number(p.amount), 0)

    // 5. Cohort config hash (detect drift)
    const { data: cohorts } = await db
      .from('cohorts')
      .select('id, payout_split_percent, lifetime_cap_multiple, first_payout_cap_amount, max_payout_percent, payout_cooldown_days')
      .eq('is_active', true)
      .order('name')

    // Simple hash: stringify sorted config
    const cohortConfigHash = cohorts
      ? await hashString(JSON.stringify(cohorts))
      : null

    // 6. Check for unapproved two-key changes (safety setting drift)
    const { data: pendingChanges } = await db
      .from('safety_setting_changes')
      .select('id, setting_key, proposed_at')
      .eq('status', 'pending')

    if (pendingChanges && pendingChanges.length > 0) {
      for (const change of pendingChanges) {
        const ageMs = Date.now() - new Date(change.proposed_at).getTime()
        if (ageMs > 48 * 60 * 60 * 1000) {
          alarms.push({
            code: 'STALE_SAFETY_PROPOSAL',
            level: 'warning',
            message: `Safety setting change for "${change.setting_key}" pending >48h without approval`,
          })
        }
      }
    }

    // 7. Write snapshot via service-role RPC
    const { data: snapshotId, error: snapshotError } = await db.rpc('create_risk_snapshot', {
      _pass_rate: passRate,
      _pass_rate_alert_level: passRateAlertLevel,
      _total_accounts: totalAccounts,
      _passed_accounts: passedAccounts,
      _simulation_run_id: simulationRunId,
      _simulation_stale: simulationStale,
      _simulation_age_hours: simulationAgeHours,
      _reserve_breach_prob: reserveBreachProb,
      _annual_loss_prob: annualLossProb,
      _worst_month: worstMonth,
      _cohort_config_hash: cohortConfigHash,
      _net_buffer: netBuffer,
      _pending_payouts_count: pendingPayoutsCount,
      _pending_payouts_amount: pendingPayoutsAmount,
      _alarms: JSON.stringify(alarms),
      _metadata: JSON.stringify({
        triggered_by: userId ?? 'cron',
        pending_safety_changes: pendingChanges?.length ?? 0,
      }),
    })

    if (snapshotError) {
      throw new Error(`Failed to create risk snapshot: ${snapshotError.message}`)
    }

    // 8. Create staff notifications for critical/high alarms
    const criticalAlarms = alarms.filter(a => a.level === 'critical' || a.level === 'high')
    if (criticalAlarms.length > 0) {
      await db.from('staff_notifications').insert({
        notification_type: 'risk_alarm',
        title: `Risk Snapshot: ${criticalAlarms.length} alarm(s)`,
        body: criticalAlarms.map(a => `[${a.level.toUpperCase()}] ${a.message}`).join('\n'),
        data: { snapshot_id: snapshotId, alarms: criticalAlarms },
        idempotency_key: `risk_snapshot:${new Date().toISOString().slice(0, 13)}`, // 1 per hour max
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        snapshot_id: snapshotId,
        alarms_count: alarms.length,
        alarms,
        summary: {
          pass_rate: passRate,
          pass_rate_alert_level: passRateAlertLevel,
          simulation_stale: simulationStale,
          simulation_age_hours: simulationAgeHours,
          reserve_breach_probability: reserveBreachProb,
          net_buffer: netBuffer,
          pending_payouts: { count: pendingPayoutsCount, amount: pendingPayoutsAmount },
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Risk snapshot error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
