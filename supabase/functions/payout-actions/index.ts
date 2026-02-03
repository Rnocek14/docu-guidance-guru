import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// All payout actions are admin-only
type PayoutAction = 'approve' | 'reject' | 'request_more_info' | 'mark_paid'

interface PayoutActionRequest {
  action: PayoutAction
  payout_id: string
  reason?: string           // Required for reject, request_more_info
  payment_reference?: string // Required for mark_paid
  idempotency_key?: string
}

// Valid payout state transitions
const PAYOUT_TRANSITIONS: Record<PayoutAction, { from: string[]; to: string }> = {
  approve: {
    from: ['pending', 'under_review'],
    to: 'approved'
  },
  reject: {
    from: ['pending', 'under_review'],
    to: 'rejected'
  },
  request_more_info: {
    from: ['pending'],
    to: 'under_review'
  },
  mark_paid: {
    from: ['approved'],
    to: 'paid'
  },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Validate authorization
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.replace('Bearer ', '')

    // Create service role client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Validate token and get user
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = userData.user.id

    // ADMIN ONLY: Check for admin role
    const { data: roleData } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .single()

    if (!roleData) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Admin role required for payout actions' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: PayoutActionRequest = await req.json()

    if (!body.payout_id || !body.action) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: payout_id, action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate action-specific requirements
    if (['reject', 'request_more_info'].includes(body.action) && !body.reason) {
      return new Response(
        JSON.stringify({ error: `Reason is required for ${body.action}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (body.action === 'mark_paid' && !body.payment_reference) {
      return new Response(
        JSON.stringify({ error: 'Payment reference is required for mark_paid' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get payout with account info
    const { data: payout, error: payoutError } = await supabaseAdmin
      .from('payouts')
      .select('*, accounts!inner(id, status, account_number, current_balance, total_pnl)')
      .eq('id', body.payout_id)
      .single()

    if (payoutError || !payout) {
      return new Response(
        JSON.stringify({ error: 'Payout not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const transition = PAYOUT_TRANSITIONS[body.action]
    
    // Validate state transition
    if (!transition.from.includes(payout.status)) {
      return new Response(
        JSON.stringify({ 
          error: `Invalid payout state transition: cannot ${body.action} from ${payout.status}`,
          allowed_from: transition.from
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate account is in compatible state for approval
    if (body.action === 'approve') {
      const account = payout.accounts
      if (!['passed', 'payout_requested', 'payout_under_review'].includes(account.status)) {
        return new Response(
          JSON.stringify({ 
            error: `Cannot approve payout: account status is ${account.status}`,
            hint: 'Account must be in passed or payout status to approve'
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    const requestId = body.idempotency_key || crypto.randomUUID()
    const previousStatus = payout.status
    const newStatus = transition.to

    // Update payout
    const updateData: Record<string, unknown> = {
      status: newStatus,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    }

    if (body.reason) {
      updateData.review_notes = body.reason
    }

    if (body.action === 'mark_paid') {
      updateData.paid_at = new Date().toISOString()
      updateData.payment_reference = body.payment_reference
    }

    const { error: updateError } = await supabaseAdmin
      .from('payouts')
      .update(updateData)
      .eq('id', body.payout_id)

    if (updateError) {
      throw new Error(`Failed to update payout: ${updateError.message}`)
    }

    // Update account status based on payout action
    let accountNewStatus: string | null = null
    if (body.action === 'approve') {
      accountNewStatus = 'payout_approved'
    } else if (body.action === 'request_more_info') {
      accountNewStatus = 'payout_under_review'
    }

    if (accountNewStatus) {
      await supabaseAdmin
        .from('accounts')
        .update({ status: accountNewStatus })
        .eq('id', payout.account_id)
    }

    // Determine audit action and event type
    const auditActions: Record<PayoutAction, string> = {
      approve: 'payout_approved',
      reject: 'payout_rejected',
      request_more_info: 'status_changed',
      mark_paid: 'status_changed',
    }

    const eventTypes: Record<PayoutAction, string> = {
      approve: 'payout_approved',
      reject: 'payout_rejected',
      request_more_info: 'payout_under_review',
      mark_paid: 'payout_paid',
    }

    // Create audit log
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      account_id: payout.account_id,
      action: auditActions[body.action],
      request_id: requestId,
      reason: body.reason || `Payout ${body.action}`,
      details: {
        payout_id: body.payout_id,
        previous_status: previousStatus,
        new_status: newStatus,
        action_type: body.action,
        amount: payout.amount,
        payment_reference: body.payment_reference || null,
        actor_role: 'admin',
      },
    })

    // Create trader-visible event
    const eventExplanations: Record<PayoutAction, string> = {
      approve: `Your payout request for $${payout.amount.toLocaleString()} has been approved.`,
      reject: `Your payout request has been declined. Reason: ${body.reason}`,
      request_more_info: `Additional information has been requested for your payout. Reason: ${body.reason}`,
      mark_paid: `Your payout of $${payout.amount.toLocaleString()} has been sent. Reference: ${body.payment_reference}`,
    }

    await supabaseAdmin.from('account_events').insert({
      account_id: payout.account_id,
      event_type: eventTypes[body.action],
      request_id: requestId,
      event_data: {
        payout_id: body.payout_id,
        previous_status: previousStatus,
        new_status: newStatus,
        amount: payout.amount,
        explanation: eventExplanations[body.action],
        payment_reference: body.payment_reference || null,
        actor_role: 'admin',
      },
    })

    return new Response(
      JSON.stringify({
        success: true,
        payout_id: body.payout_id,
        account_id: payout.account_id,
        previous_status: previousStatus,
        new_status: newStatus,
        action: body.action,
        request_id: requestId,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Payout action error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
