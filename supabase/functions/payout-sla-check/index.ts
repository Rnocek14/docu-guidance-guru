import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================
// Payout SLA Escalation Cron
// Checks for payouts that have been pending/under_review/approved
// beyond SLA thresholds and sends staff notifications.
//
// Schedule: Every hour via pg_cron
// Idempotent: uses deterministic idempotency_key per payout + tier
// ============================================================

const SLA_TIERS = [
  {
    hoursThreshold: 72,
    statuses: ['approved'],
    notificationType: 'payout_initiation_delayed',
    title: (id: string, acct: string) => `⚠️ Payout ${id} approved >72h but not initiated`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} was approved ${hrs.toFixed(0)}h ago but payment has not been initiated. Act now.`,
  },
  {
    hoursThreshold: 72,
    statuses: ['pending', 'under_review'],
    notificationType: 'payout_sla_breach',
    title: (id: string, acct: string) => `🚨 Payout ${id} exceeds 72h SLA`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} has been in review for ${hrs.toFixed(0)} hours. Exceeds 72h SLA. Proactive trader communication recommended.`,
  },
  {
    hoursThreshold: 48,
    statuses: ['pending', 'under_review'],
    notificationType: 'payout_sla_warning',
    title: (id: string, acct: string) => `⏰ Payout ${id} pending >48h`,
    body: (id: string, acct: string, hrs: number) =>
      `Payout ${id} for account ${acct} has been pending for ${hrs.toFixed(0)} hours. Review immediately.`,
  },
]

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Auth: cron secret or service role
  const authHeader = req.headers.get('Authorization')
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
    // Fetch all non-terminal payouts older than 48h
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { data: overdue, error } = await supabase
      .from('payouts')
      .select('id, status, requested_at, account_id, amount')
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
      const ageHours = (now - new Date(payout.requested_at).getTime()) / (1000 * 60 * 60)

      // Find the highest applicable SLA tier
      for (const tier of SLA_TIERS) {
        if (ageHours >= tier.hoursThreshold && tier.statuses.includes(payout.status)) {
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
              },
              idempotency_key: idempotencyKey,
            })

          if (insertErr) {
            if (insertErr.code === '23505') {
              // Already notified for this tier — skip
            } else {
              console.error(`SLA notification failed for payout ${payout.id}:`, insertErr.message)
            }
          } else {
            escalations++
            console.log(`SLA escalation: ${tier.notificationType} for payout ${payout.id} (${ageHours.toFixed(0)}h)`)
          }

          // Only fire the highest applicable tier per payout
          break
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
