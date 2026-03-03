import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================================
// N-SWEEP BATCH ORCHESTRATOR
// Runs run-simulation for each accountsPerMonth value, tags with sweep_id.
// Auth: admin JWT OR x-cron-secret (service-to-service)
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

interface SweepRequest {
  preset?: string
  seed?: number
  months?: number
  iterations?: number
  reserve_threshold?: number
  accountsPerMonthList: number[]
  knobs?: Record<string, unknown>
  overrides?: Record<string, unknown>
  sweep_type?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)

  // ── Auth: JWT (admin/risk_officer) OR x-cron-secret ──
  let triggeredBy: string | null = null
  const cronSecretHeader = req.headers.get('x-cron-secret')
  const authHeader = req.headers.get('Authorization')

  if (cronSecretHeader) {
    let expectedSecret = Deno.env.get('CRON_SECRET') ?? ''
    if (!expectedSecret) {
      try {
        const { data } = await serviceClient.from('internal_secrets').select('value').eq('key', 'CRON_SECRET').single()
        expectedSecret = data?.value ?? ''
      } catch { /* best effort */ }
    }
    if (!expectedSecret || cronSecretHeader !== expectedSecret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
  } else if (authHeader?.startsWith('Bearer ')) {
    const jwt = authHeader.replace('Bearer ', '')
    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: userData, error: userError } = await anonClient.auth.getUser(jwt)
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    triggeredBy = userData.user.id
    const { data: isAdmin } = await serviceClient.rpc('has_role', { _user_id: triggeredBy, _role: 'admin' })
    const { data: isRisk } = await serviceClient.rpc('has_role', { _user_id: triggeredBy, _role: 'risk_officer' })
    if (isAdmin !== true && isRisk !== true) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin or risk_officer required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
  } else {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const body: SweepRequest = await req.json()
    const {
      preset = 'baseline',
      seed = 42,
      months = 12,
      iterations = 2000,
      reserve_threshold = 16000,
      accountsPerMonthList,
      knobs = {},
      overrides = {},
      sweep_type = 'N_SWEEP',
    } = body

    if (!accountsPerMonthList || !Array.isArray(accountsPerMonthList) || accountsPerMonthList.length === 0) {
      return new Response(JSON.stringify({ error: 'accountsPerMonthList is required (array of numbers)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (accountsPerMonthList.length > 10) {
      return new Response(JSON.stringify({ error: 'Max 10 sweep points per call' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const sweepId = crypto.randomUUID()
    const simUrl = `${supabaseUrl}/functions/v1/run-simulation`

    // Resolve CRON_SECRET for service-to-service calls to run-simulation
    let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    if (!cronSecret) {
      try {
        const { data } = await serviceClient.from('internal_secrets').select('value').eq('key', 'CRON_SECRET').single()
        cronSecret = data?.value ?? ''
      } catch { /* best effort */ }
    }
    if (!cronSecret) {
      return new Response(JSON.stringify({ error: 'CRON_SECRET not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const runIds: string[] = []
    const errors: { n: number; error: string }[] = []
    const summaries: { n: number; run_id: string | null; profit_mean: number; profit_p5: number; p_loss: number; max_dd: number; reserve_breach: number; worst_month: number; duration_ms: number }[] = []

    // Sequential execution — each run-simulation invocation gets its own 15s budget
    for (const n of accountsPerMonthList) {
      try {
        const simBody = {
          iterations,
          months,
          seed,
          reserve_threshold,
          triggered_by: triggeredBy,
          overrides: {
            accountsPerMonth: n,
            ...overrides,
            knobs: {
              ...knobs,
            },
            // Atomic sweep tagging — run-simulation merges this into assumptions at insert time
            sweep_meta: {
              sweep_id: sweepId,
              sweep_type,
              sweep_preset: preset,
              sweep_n: n,
            },
          },
        }

        console.log(`[sweep] Starting N=${n} (sweep_id=${sweepId})`)
        const resp = await fetch(simUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': cronSecret,
          },
          body: JSON.stringify(simBody),
        })

        const data = await resp.json()
        if (!resp.ok) {
          errors.push({ n, error: data.error || `HTTP ${resp.status}` })
          console.error(`[sweep] N=${n} failed: ${data.error}`)
          continue
        }

        const runId = data.run_id as string | null

        if (runId) {
          runIds.push(runId)

          // Reserve breach: fallback chain across possible result shapes
          const reserveBreach =
            data.results?.reserve?.breachProbability ??
            data.results?.risk?.reserveBreachProbability ??
            data.results?.risk?.reserveBreach ??
            0

          summaries.push({
            n,
            run_id: runId,
            profit_mean: data.results?.profit?.mean ?? 0,
            profit_p5: data.results?.profit?.p5 ?? 0,
            p_loss: data.results?.risk?.probabilityOfLoss ?? 0,
            max_dd: data.results?.risk?.maxDrawdown ?? 0,
            reserve_breach: reserveBreach,
            worst_month: data.results?.risk?.worstMonth ?? 0,
            duration_ms: data.duration_ms ?? 0,
          })
        }

        console.log(`[sweep] N=${n} complete: run_id=${runId}, profit_mean=${data.results?.profit?.mean?.toFixed(0)}`)
      } catch (err) {
        const e = err as Error
        errors.push({ n, error: e.message })
        console.error(`[sweep] N=${n} exception: ${e.message}`)
      }
    }

    console.log(`[sweep] Complete: sweep_id=${sweepId}, ${runIds.length}/${accountsPerMonthList.length} succeeded`)

    return new Response(JSON.stringify({
      sweep_id: sweepId,
      sweep_type,
      preset,
      run_ids: runIds,
      summaries,
      errors: errors.length > 0 ? errors : undefined,
      config: { seed, months, iterations, reserve_threshold, accountsPerMonthList },
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('run-sweep error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
