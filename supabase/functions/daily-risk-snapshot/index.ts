import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

/**
 * Daily Risk Snapshot Edge Function
 * 
 * AUTH MODEL (Option B — shared secret + admin/risk JWT):
 * 1. Cron/scheduler: Must send header `X-Cron-Secret` matching env CRON_SECRET
 * 2. Manual: Must send a valid JWT for an admin or risk_officer user
 * 3. All other requests → 401
 * 
 * The SUPABASE_ANON_KEY is PUBLIC and is NEVER treated as an auth credential.
 */

interface Alarm {
  code: string
  level: 'warning' | 'elevated' | 'high' | 'critical'
  message: string
  value?: number
  threshold?: number
}

/**
 * Constant-time secret comparison via SHA-256 digest.
 * Prevents timing side-channels on the cron secret.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)).then(buf => new Uint8Array(buf)),
    crypto.subtle.digest('SHA-256', enc.encode(b)).then(buf => new Uint8Array(buf)),
  ])
  if (ah.length !== bh.length) return false
  let diff = 0
  for (let i = 0; i < ah.length; i++) diff |= ah[i] ^ bh[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const cronSecret = Deno.env.get('CRON_SECRET')

    // =========================================================================
    // AUTH GATE — fail-closed, no bypass, no env-state leakage
    // =========================================================================
    let triggeredBy: string = 'unknown'

    const incomingCronSecret = (req.headers.get('X-Cron-Secret') ?? '').trim()
    const authHeader = req.headers.get('Authorization')

    // Reject dual-auth outright — prevents header smuggling / proxy misconfigs
    if (incomingCronSecret && authHeader) {
      console.warn('daily-risk-snapshot: both X-Cron-Secret and Authorization provided; rejecting')
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (incomingCronSecret) {
      // Path 1: Cron/scheduler with shared secret
      if (!cronSecret || cronSecret.length < 16) {
        console.error('CRON_SECRET env not configured or too short — server misconfiguration')
        return new Response(
          JSON.stringify({ error: 'Service unavailable' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (!(await constantTimeEqual(incomingCronSecret, cronSecret))) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      triggeredBy = 'cron'
    } else if (authHeader?.startsWith('Bearer ')) {
      // Path 2: Admin/risk_officer JWT — cheap-reject garbage before hitting auth server
      const jwt = authHeader.slice('Bearer '.length).trim()
      if (!jwt || jwt.length > 5000 || jwt.split('.').length !== 3) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
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
      const userId = userData.user.id

      // Role check — fail-closed: RPC error or insufficient role → 403
      const db = createClient(supabaseUrl, serviceKey)
      const { data: isAdmin, error: adminErr } = await db.rpc('has_role', { _user_id: userId, _role: 'admin' })
      const { data: isRisk, error: riskErr } = await db.rpc('has_role', { _user_id: userId, _role: 'risk_officer' })
      if (adminErr || riskErr) {
        console.error('Role check RPC failed:', adminErr?.message ?? riskErr?.message)
        return new Response(
          JSON.stringify({ error: 'Forbidden' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (isAdmin !== true && isRisk !== true) {
        return new Response(
          JSON.stringify({ error: 'Forbidden' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      triggeredBy = userId
    } else {
      // Path 3: No auth at all → hard reject
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // =========================================================================
    // SNAPSHOT LOGIC (unchanged business logic below)
    // =========================================================================
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

    // 7. Write snapshot
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
        triggered_by: triggeredBy,
        pending_safety_changes: pendingChanges?.length ?? 0,
      }),
    })

    if (snapshotError) {
      throw new Error(`Failed to create risk snapshot: ${snapshotError.message}`)
    }

    // 8. Idempotent staff notifications for critical/high alarms
    const criticalAlarms = alarms.filter(a => a.level === 'critical' || a.level === 'high')
    if (criticalAlarms.length > 0) {
      const idempotencyKey = `risk_snapshot:${new Date().toISOString().slice(0, 13)}`

      // Use upsert with ON CONFLICT to prevent duplicate notifications
      await db.from('staff_notifications').upsert(
        {
          notification_type: 'risk_alarm',
          title: `Risk Snapshot: ${criticalAlarms.length} alarm(s)`,
          body: criticalAlarms.map(a => `[${a.level.toUpperCase()}] ${a.message}`).join('\n'),
          data: { snapshot_id: snapshotId, alarms: criticalAlarms },
          idempotency_key: idempotencyKey,
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        snapshot_id: snapshotId,
        alarms_count: alarms.length,
        alarms,
        triggered_by: triggeredBy,
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
