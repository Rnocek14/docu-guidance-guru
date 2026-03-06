import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================================
// N-SWEEP / VARIANT-SWEEP BATCH ORCHESTRATOR
// Runs run-simulation for each (N, variant) combination, tags with sweep_id.
// Auth: admin JWT OR x-cron-secret (service-to-service)
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

interface SweepVariant {
  id: string                         // e.g. "baseline", "guarded"
  label: string                      // human-readable
  knobs: Record<string, unknown>     // knob overrides for this variant
}

interface SweepRequest {
  preset?: string
  seed?: number
  months?: number
  iterations?: number
  reserve_threshold?: number
  accountsPerMonthList: number[]
  knobs?: Record<string, unknown>       // shared knobs (merged with variant knobs)
  overrides?: Record<string, unknown>
  sweep_type?: string
  variants?: SweepVariant[]             // if present, each N runs once per variant
}

interface SweepSummary {
  n: number
  variant_id: string
  variant_label: string
  run_id: string | null
  profit_mean: number
  profit_p5: number
  p_loss: number
  max_dd: number
  reserve_breach: number
  worst_month: number
  duration_ms: number
  // Ladder evidence (optional — populated when available)
  avg_clean_payout_count?: number
  clean_p50?: number
  clean_p90?: number
  ever_reached_pro_pct?: number
  ever_reached_elite_pct?: number
  cap_binding_rate?: number
  avg_payout_size?: number
  // Cap audit fields
  avg_payout_pre_cap?: number
  avg_payout_post_cap?: number
  cap_dollars_saved?: number
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
      variants,
    } = body

    if (!accountsPerMonthList || !Array.isArray(accountsPerMonthList) || accountsPerMonthList.length === 0) {
      return new Response(JSON.stringify({ error: 'accountsPerMonthList is required (array of numbers)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Build variant list — default to single "default" variant if none provided
    const effectiveVariants: SweepVariant[] = variants && variants.length > 0
      ? variants
      : [{ id: 'default', label: 'Default', knobs: {} }]

    const totalRuns = accountsPerMonthList.length * effectiveVariants.length
    if (totalRuns > 20) {
      return new Response(JSON.stringify({ error: `Max 20 total runs per sweep (got ${totalRuns}: ${accountsPerMonthList.length} N × ${effectiveVariants.length} variants)` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const sweepId = crypto.randomUUID()
    const simUrl = `${supabaseUrl}/functions/v1/run-simulation`

    // Resolve CRON_SECRET for service-to-service calls
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
    const errors: { n: number; variant_id: string; error: string }[] = []
    const summaries: SweepSummary[] = []

    // Sequential execution — each run gets its own budget
    for (const n of accountsPerMonthList) {
      for (const variant of effectiveVariants) {
        try {
          // Merge shared knobs with variant knobs (variant wins on conflict)
          const mergedKnobs = { ...(knobs ?? {}), ...(variant.knobs ?? {}) }

          const simBody = {
            iterations,
            months,
            seed,
            reserve_threshold,
            triggered_by: triggeredBy,
            overrides: {
              accountsPerMonth: n,
              ...overrides,
              knobs: mergedKnobs,
              sweep_meta: {
                sweep_id: sweepId,
                sweep_type,
                sweep_preset: preset,
                sweep_n: n,
                variant_id: variant.id,
                variant_label: variant.label,
              },
            },
          }

          console.log(`[sweep] Starting N=${n} variant=${variant.id} (sweep_id=${sweepId})`)
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
            errors.push({ n, variant_id: variant.id, error: data.error || `HTTP ${resp.status}` })
            console.error(`[sweep] N=${n} variant=${variant.id} failed: ${data.error}`)
            continue
          }

          const runId = data.run_id as string | null

          if (runId) {
            runIds.push(runId)

            // Reserve breach: fallback chain
            const reserveBreach =
              data.results?.reserve?.breachProbability ??
              data.results?.risk?.reserveBreachProbability ??
              data.results?.risk?.reserveBreach ??
              0

            // Extract ladder evidence fields — fallback chain for different nesting
            const le =
              data.results?.ladderEvidence ??
              data.results?.full_results?.ladderEvidence ??
              data.full_results?.ladderEvidence ??
              null
            const pd =
              data.results?.payoutDiagnostics ??
              data.results?.full_results?.payoutDiagnostics ??
              data.full_results?.payoutDiagnostics ??
              null

            // Cap audit: compute dollars saved from cap regime
            const avgPreCap = pd?.avgFirstPayoutBeforeCap ?? pd?.avgGrossInCapRegime ?? undefined
            const avgPostCap = pd?.avgFirstPayoutAfterCap ?? pd?.avgNetInCapRegime ?? undefined
            const capHits = pd?.capHits ?? 0
            const capDollarsSaved = (avgPreCap != null && avgPostCap != null && capHits > 0)
              ? (avgPreCap - avgPostCap) * capHits
              : undefined

            summaries.push({
              n,
              variant_id: variant.id,
              variant_label: variant.label,
              run_id: runId,
              profit_mean: data.results?.profit?.mean ?? 0,
              profit_p5: data.results?.profit?.p5 ?? 0,
              p_loss: data.results?.risk?.probabilityOfLoss ?? 0,
              max_dd: data.results?.risk?.maxDrawdown ?? 0,
              reserve_breach: reserveBreach,
              worst_month: data.results?.risk?.worstMonth ?? 0,
              duration_ms: data.duration_ms ?? 0,
              // Ladder evidence
              avg_clean_payout_count: le?.avgCleanPayoutCount_endOfIter ?? undefined,
              clean_p50: le?.cleanPayoutCountPercentiles?.p50 ?? undefined,
              clean_p90: le?.cleanPayoutCountPercentiles?.p90 ?? undefined,
              ever_reached_pro_pct: le?.accountsEverReachedProPct ?? undefined,
              ever_reached_elite_pct: le?.accountsEverReachedElitePct ?? undefined,
              cap_binding_rate: pd?.firstPayoutCapBindingRate ?? undefined,
              avg_payout_size: pd?.avgPayoutSize ?? undefined,
              // Cap audit
              avg_payout_pre_cap: avgPreCap,
              avg_payout_post_cap: avgPostCap,
              cap_dollars_saved: capDollarsSaved,
            })
          }

          console.log(`[sweep] N=${n} variant=${variant.id} complete: run_id=${runId}, profit_mean=${data.results?.profit?.mean?.toFixed(0)}`)
        } catch (err) {
          const e = err as Error
          errors.push({ n, variant_id: variant.id, error: e.message })
          console.error(`[sweep] N=${n} variant=${variant.id} exception: ${e.message}`)
        }
      }
    }

    console.log(`[sweep] Complete: sweep_id=${sweepId}, ${runIds.length}/${totalRuns} succeeded`)

    return new Response(JSON.stringify({
      sweep_id: sweepId,
      sweep_type,
      preset,
      variants: effectiveVariants.map(v => ({ id: v.id, label: v.label })),
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
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})