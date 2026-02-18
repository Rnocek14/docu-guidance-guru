import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================
// Payout SLA Escalation Cron
// Checks for payouts that have been pending/under_review/approved
// beyond SLA thresholds and sends staff notifications.
//
// Schedule: Every hour via pg_cron
// Idempotent: uses deterministic idempotency_key per payout + tier
// ============================================================

// Tiers are CODE-ENFORCED descending by severity at init.
// The loop breaks on first match, so highest-severity wins per payout.
const SLA_TIERS_UNSORTED = [
  {
    hoursThreshold: 72,
    statuses: ['approved'],
    notificationType: 'payout_initiation_delayed',
    useApprovedAt: true,
    severity: 3, // highest
    title: (id: string, acct: string) => `⚠️ Payout ${id} approved >72h but not initiated`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} was approved ${hrs.toFixed(0)}h ago but payment has not been initiated. Act now.`,
  },
  {
    hoursThreshold: 72,
    statuses: ['pending', 'under_review'],
    notificationType: 'payout_sla_breach',
    useApprovedAt: false,
    severity: 2,
    title: (id: string, acct: string) => `🚨 Payout ${id} exceeds 72h SLA`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} has been in review for ${hrs.toFixed(0)} hours. Exceeds 72h SLA. Proactive trader communication recommended.`,
  },
  {
    hoursThreshold: 48,
    statuses: ['pending', 'under_review'],
    notificationType: 'payout_sla_warning',
    useApprovedAt: false,
    severity: 1,
    title: (id: string, acct: string) => `⏰ Payout ${id} pending >48h`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} has been pending for ${hrs.toFixed(0)} hours. Review immediately.`,
  },
]

// Sort descending: highest severity first (hoursThreshold desc, severity desc)
const SLA_TIERS = [...SLA_TIERS_UNSORTED].sort((a, b) => {
  if (b.hoursThreshold !== a.hoursThreshold) return b.hoursThreshold - a.hoursThreshold
  return b.severity - a.severity
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Auth: cron secret only
  const authHeader = req.headers.get('Authorization')

  // Resolve CRON_SECRET: prefer env var, fallback to internal_secrets table
  let cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  if (!cronSecret) {
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

  if (!cronSecret) {
    console.error('CRON_SECRET not configured')
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { data: overdue, error } = await supabase
      .from('payouts')
      .select('id, status, requested_at, approved_at, account_id, amount')
      .in('status', ['pending', 'under_review', 'approved'])
      .lt('requested_at', cutoff48h)

    if (error) {
      console.error('Failed to query overdue payouts:', error.message)
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!overdue || overdue.length === 0) {
      return new Response(JSON.stringify({ checked: true, escalations: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let escalations = 0
    const now = Date.now()

    for (const payout of overdue) {
      for (const tier of SLA_TIERS) {
        if (!tier.statuses.includes(payout.status)) continue

        // Use approved_at for initiation-delayed, requested_at for others
        const referenceTime = tier.useApprovedAt && payout.approved_at
          ? new Date(payout.approved_at).getTime()
          : new Date(payout.requested_at).getTime()

        const ageHours = (now - referenceTime) / (1000 * 60 * 60)

        if (ageHours >= tier.hoursThreshold) {
          const idempotencyKey = `${tier.notificationType}:${payout.id}`
          const { error: insertErr } = await supabase
            .from('staff_notifications')
            .insert({
              notification_type: tier.notificationType,
              title: tier.title(payout.id.slice(0, 8), payout.account_id.slice(0, 8)),
              body: tier.body(payout.id.slice(0, 8), payout.account_id.slice(0, 8), ageHours),
              data: {
                payout_id: payout.id,
                account_id: payout.account_id,
                status: payout.status,
                amount: payout.amount,
                age_hours: Math.round(ageHours),
                requested_at: payout.requested_at,
                approved_at: payout.approved_at,
                reference_time: tier.useApprovedAt ? 'approved_at' : 'requested_at',
              },
              idempotency_key: idempotencyKey,
            })

          if (insertErr) {
            if (insertErr.code === '23505') {
              // Already notified — skip
            } else {
              console.error(`SLA notification failed for payout ${payout.id}:`, insertErr.message)
            }
          } else {
            escalations++
            console.log(`SLA escalation: ${tier.notificationType} for payout ${payout.id} (${ageHours.toFixed(0)}h)`)
          }

          break // Only fire the highest applicable tier per payout
        }
      }
    }

    console.log(`Payout SLA check: ${overdue.length} overdue, ${escalations} new escalations`)

    return new Response(JSON.stringify({
      checked: true,
      overdue_count: overdue.length,
      escalations,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('payout-sla-check error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
