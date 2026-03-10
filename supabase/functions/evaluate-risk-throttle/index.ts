import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * evaluate-risk-throttle — Lighter v1
 *
 * Runs every 6 hours via pg_cron.
 * Calculates pass rates across 7d/14d/30d windows.
 * Sets throttle state: green / yellow / orange / red.
 *
 * Controls:
 *   - purchase_enabled (false = block new checkouts)
 *   - eligibility_delay_bonus_days (extends payout wait)
 *
 * INVARIANT: Only machines tighten. Humans loosen.
 */

interface ThrottleDecision {
  state: 'green' | 'yellow' | 'orange' | 'red'
  purchase_enabled: boolean
  eligibility_delay_bonus_days: number
  reason: string
}

function decide(passRate30d: number, passRate14d: number, passRate7d: number): ThrottleDecision {
  // RED: >20% 30d pass rate or >25% 7d spike
  if (passRate30d > 20 || passRate7d > 25) {
    return {
      state: 'red',
      purchase_enabled: false,
      eligibility_delay_bonus_days: 14,
      reason: passRate7d > 25
        ? `7d pass rate spike: ${passRate7d.toFixed(1)}%`
        : `30d pass rate critical: ${passRate30d.toFixed(1)}%`,
    }
  }

  // ORANGE: 18-20% 30d or >22% 14d
  if (passRate30d > 18 || passRate14d > 22) {
    return {
      state: 'orange',
      purchase_enabled: true,
      eligibility_delay_bonus_days: 7,
      reason: `Elevated pass rates: 30d=${passRate30d.toFixed(1)}% 14d=${passRate14d.toFixed(1)}%`,
    }
  }

  // YELLOW: 16-18% 30d
  if (passRate30d > 16) {
    return {
      state: 'yellow',
      purchase_enabled: true,
      eligibility_delay_bonus_days: 3,
      reason: `Pass rate approaching threshold: 30d=${passRate30d.toFixed(1)}%`,
    }
  }

  // GREEN
  return {
    state: 'green',
    purchase_enabled: true,
    eligibility_delay_bonus_days: 0,
    reason: `Normal: 30d=${passRate30d.toFixed(1)}%`,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Auth: cron secret OR admin JWT (for "Run now" button)
    const authHeader = req.headers.get('Authorization') ?? ''
    const cronSecretHeader = req.headers.get('X-Cron-Secret') ?? ''

    // Resolve CRON_SECRET: prefer env var, fallback to internal_secrets table
    let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    if (!cronSecret || cronSecret.length < 16) {
      console.warn('CRON_SECRET env var missing/short — falling back to internal_secrets table\n')
      try {
        const sbLookup = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        const { data } = await sbLookup
          .from('internal_secrets')
          .select('value')
          .eq('key', 'CRON_SECRET')
          .single()
        cronSecret = data?.value ?? ''
      } catch { /* best effort */ }
    }

    // Accept cron secret via X-Cron-Secret header (preferred) or Authorization: Bearer
    const isCron = cronSecret && (
      cronSecretHeader === cronSecret ||
      authHeader === `Bearer ${cronSecret}`
    )

    let isAdmin = false
    if (!isCron && authHeader.startsWith('Bearer ')) {
      // Check if caller is an authenticated admin
      const jwt = authHeader.replace('Bearer ', '')
      const supabaseAuth = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: `Bearer ${jwt}` } } }
      )
      const { data: userData } = await supabaseAuth.auth.getUser()
      if (userData?.user) {
        const adminClient = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        const { data: hasAdminRole } = await adminClient.rpc('has_role', {
          _user_id: userData.user.id,
          _role: 'admin',
        })
        isAdmin = hasAdminRole === true
      }
    }

    if (!isCron && !isAdmin) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const now = new Date()

    // Calculate pass rates for 7d, 14d, 30d windows — parallelized for scale
    const windows = [7, 14, 30] as const
    const windowStarts = windows.map(days => {
      const d = new Date(now)
      d.setDate(d.getDate() - days)
      return d.toISOString()
    })

    // Fire all 6 queries in parallel (2 per window) instead of sequential
    const [
      { count: passed7 }, { count: failed7 },
      { count: passed14 }, { count: failed14 },
      { count: passed30 }, { count: failed30 },
    ] = await Promise.all([
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'passed').gte('passed_at', windowStarts[0]),
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'failed_confirmed').gte('failed_at', windowStarts[0]),
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'passed').gte('passed_at', windowStarts[1]),
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'failed_confirmed').gte('failed_at', windowStarts[1]),
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'passed').gte('passed_at', windowStarts[2]),
      supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'failed_confirmed').gte('failed_at', windowStarts[2]),
    ])

    const rates: Record<number, { passed: number; total: number; rate: number }> = {}
    const windowCounts = [
      [7, passed7 ?? 0, failed7 ?? 0],
      [14, passed14 ?? 0, failed14 ?? 0],
      [30, passed30 ?? 0, failed30 ?? 0],
    ] as const
    for (const [days, passed, failed] of windowCounts) {
      const total = passed + failed
      rates[days] = { passed, total, rate: total > 0 ? (passed / total) * 100 : 0 }
    }

    const passRate7d = rates[7].rate
    const passRate14d = rates[14].rate
    const passRate30d = rates[30].rate

    // Get current state to check for manual override
    const { data: currentState } = await supabase
      .from('risk_throttle_state')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000002')
      .single()

    const decision = decide(passRate30d, passRate14d, passRate7d)

    // INVARIANT: Only machines tighten. Humans loosen.
    // If admin manually loosened (override is more permissive than auto), respect it.
    // But if auto wants to TIGHTEN beyond current, always tighten.
    const stateOrder = { green: 0, yellow: 1, orange: 2, red: 3 }
    const autoSeverity = stateOrder[decision.state]
    const currentSeverity = stateOrder[(currentState?.state ?? 'green') as keyof typeof stateOrder] ?? 0

    let finalDecision = decision

    if (currentState?.manual_override_at) {
      const overrideAge = now.getTime() - new Date(currentState.manual_override_at).getTime()
      const overrideExpiry = 24 * 60 * 60 * 1000 // 24h

      if (overrideAge < overrideExpiry && autoSeverity <= currentSeverity) {
        // Manual override is still fresh and auto isn't trying to escalate — respect it
        console.log(`Manual override active (${currentState.manual_override_reason}), skipping auto-update`)

        // Still update metrics for visibility
        await supabase.rpc('update_risk_throttle', {
          p_state: currentState.state,
          p_purchase_enabled: currentState.purchase_enabled,
          p_eligibility_delay_bonus_days: currentState.eligibility_delay_bonus_days,
          p_pass_rate_7d: passRate7d,
          p_pass_rate_14d: passRate14d,
          p_pass_rate_30d: passRate30d,
          p_metrics_snapshot: {
            windows: rates,
            evaluated_at: now.toISOString(),
            manual_override_active: true,
          },
          p_reason: currentState.reason,
        })

        // Log to cron_http_runs
        await supabase.from('cron_http_runs').insert({
          jobname: 'evaluate-risk-throttle',
          http_status: 200,
          http_content: JSON.stringify({
            state: currentState.state,
            manual_override: true,
            pass_rate_30d: passRate30d,
          }),
        })

        return new Response(JSON.stringify({
          state: currentState.state,
          manual_override: true,
          metrics: rates,
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Apply decision
    await supabase.rpc('update_risk_throttle', {
      p_state: finalDecision.state,
      p_purchase_enabled: finalDecision.purchase_enabled,
      p_eligibility_delay_bonus_days: finalDecision.eligibility_delay_bonus_days,
      p_pass_rate_7d: passRate7d,
      p_pass_rate_14d: passRate14d,
      p_pass_rate_30d: passRate30d,
      p_metrics_snapshot: {
        windows: rates,
        evaluated_at: now.toISOString(),
        previous_state: currentState?.state ?? 'unknown',
      },
      p_reason: finalDecision.reason,
    })

    // Log state transition if changed
    if (currentState?.state !== finalDecision.state) {
      console.log(`Risk throttle: ${currentState?.state ?? 'unknown'} → ${finalDecision.state} (${finalDecision.reason})`)
    }

    // Log to cron_http_runs for health monitoring
    await supabase.from('cron_http_runs').insert({
      jobname: 'evaluate-risk-throttle',
      http_status: 200,
      http_content: JSON.stringify({
        state: finalDecision.state,
        purchase_enabled: finalDecision.purchase_enabled,
        eligibility_delay_bonus_days: finalDecision.eligibility_delay_bonus_days,
        pass_rate_30d: passRate30d,
        pass_rate_14d: passRate14d,
        pass_rate_7d: passRate7d,
      }),
    })

    return new Response(JSON.stringify({
      state: finalDecision.state,
      purchase_enabled: finalDecision.purchase_enabled,
      eligibility_delay_bonus_days: finalDecision.eligibility_delay_bonus_days,
      metrics: rates,
      reason: finalDecision.reason,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('evaluate-risk-throttle error:', error)

    // Log failure for cron health
    try {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )
      await supabase.from('cron_http_runs').insert({
        jobname: 'evaluate-risk-throttle',
        http_status: 500,
        http_content: error.message,
      })
    } catch { /* best effort */ }

    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
