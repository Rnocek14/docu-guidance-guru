import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Valid actions and their permission requirements
type ReviewAction = 
  | 'confirm_failure'   // Admin only - terminal
  | 'clear_breach'      // Admin only - reopens account
  | 'escalate'          // Risk officer or admin
  | 'add_note'          // Risk officer or admin
  | 'close_flag'        // Risk officer or admin

interface ReviewActionRequest {
  action: ReviewAction
  account_id: string
  flag_id?: string      // Required for close_flag
  reason: string
  notes?: string
  idempotency_key?: string
}

// State machine: allowed transitions
const TERMINAL_STATES = ['failed_confirmed', 'closed', 'payout_approved']
const ADMIN_ONLY_ACTIONS: ReviewAction[] = ['confirm_failure', 'clear_breach']

// Allowed state transitions per action
const STATE_TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  confirm_failure: {
    from: ['breached_detected', 'under_review'],
    to: 'failed_confirmed'
  },
  clear_breach: {
    from: ['breached_detected', 'under_review'],
    to: 'active'
  },
  escalate: {
    from: ['active', 'breached_detected', 'payout_requested'],
    to: 'under_review'
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

    // Create service role client for privileged operations
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

    // Check user roles
    const { data: roleData } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .in('role', ['risk_officer', 'admin'])

    if (!roleData || roleData.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Risk Officer or Admin role required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userRoles = roleData.map(r => r.role)
    const isAdmin = userRoles.includes('admin')
    const actorRole = isAdmin ? 'admin' : 'risk_officer'

    // Parse request body
    const body: ReviewActionRequest = await req.json()

    if (!body.account_id || !body.action) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: account_id, action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Enforce admin-only actions
    if (ADMIN_ONLY_ACTIONS.includes(body.action) && !isAdmin) {
      return new Response(
        JSON.stringify({ error: `Forbidden: Only admins can perform ${body.action}` }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Require reason for state-changing actions
    if (['confirm_failure', 'clear_breach', 'escalate', 'close_flag'].includes(body.action) && !body.reason) {
      return new Response(
        JSON.stringify({ error: 'Reason is required for this action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get current account state
    const { data: account, error: accountError } = await supabaseAdmin
      .from('accounts')
      .select('id, status, user_id, account_number')
      .eq('id', body.account_id)
      .single()

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: 'Account not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Block actions on terminal states (except for notes)
    if (TERMINAL_STATES.includes(account.status) && body.action !== 'add_note') {
      return new Response(
        JSON.stringify({ error: `Cannot perform ${body.action} on terminal status: ${account.status}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const requestId = body.idempotency_key || crypto.randomUUID()
    const previousStatus = account.status
    let result: Record<string, unknown> = { success: true, account_id: body.account_id, action: body.action, request_id: requestId }

    switch (body.action) {
      case 'confirm_failure':
      case 'clear_breach':
      case 'escalate': {
        const transition = STATE_TRANSITIONS[body.action]
        
        // Validate state transition
        if (!transition.from.includes(account.status)) {
          return new Response(
            JSON.stringify({ 
              error: `Invalid state transition: cannot ${body.action} from ${account.status}`,
              allowed_from: transition.from
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        const newStatus = transition.to

        // Update account status
        const { error: updateError } = await supabaseAdmin
          .from('accounts')
          .update({ 
            status: newStatus,
            ...(newStatus === 'failed_confirmed' ? { failed_at: new Date().toISOString() } : {})
          })
          .eq('id', body.account_id)

        if (updateError) {
          throw new Error(`Failed to update account: ${updateError.message}`)
        }

        // Determine audit action type
        const auditAction = body.action === 'confirm_failure' ? 'failure_confirmed' : 'status_changed'

        // Create audit log
        await supabaseAdmin.from('audit_logs').insert({
          user_id: userId,
          account_id: body.account_id,
          action: auditAction,
          request_id: requestId,
          reason: body.reason,
          details: {
            previous_status: previousStatus,
            new_status: newStatus,
            action_type: body.action,
            notes: body.notes || null,
            actor_role: actorRole,
          },
        })

        // Create trader-visible event
        const eventExplanations: Record<string, string> = {
          confirm_failure: `Your account has been reviewed and the breach has been confirmed. Reason: ${body.reason}`,
          clear_breach: `The detected breach has been cleared after review. Your account is now active. Reason: ${body.reason}`,
          escalate: `Your account has been escalated for additional review.`,
        }

        await supabaseAdmin.from('account_events').insert({
          account_id: body.account_id,
          event_type: body.action === 'confirm_failure' ? 'failure_confirmed' : 'status_changed',
          request_id: requestId,
          event_data: {
            previous_status: previousStatus,
            new_status: newStatus,
            reason: body.reason,
            explanation: eventExplanations[body.action],
            actor_role: actorRole,
          },
        })

        // Mark violations as confirmed if confirming failure
        if (body.action === 'confirm_failure') {
          await supabaseAdmin
            .from('violations')
            .update({
              confirmed_by: userId,
              confirmed_at: new Date().toISOString(),
              confirmation_notes: body.notes || body.reason,
            })
            .eq('account_id', body.account_id)
            .is('confirmed_at', null)
        }

        result = { ...result, previous_status: previousStatus, new_status: newStatus }
        break
      }

      case 'add_note': {
        // Notes are audit-only, no state change
        await supabaseAdmin.from('audit_logs').insert({
          user_id: userId,
          account_id: body.account_id,
          action: 'status_changed', // Using existing enum, but details clarify it's a note
          request_id: requestId,
          reason: body.reason || 'Review note added',
          details: {
            action_type: 'add_note',
            note: body.notes || body.reason,
            actor_role: actorRole,
          },
        })
        result = { ...result, note_added: true }
        break
      }

      case 'close_flag': {
        if (!body.flag_id) {
          return new Response(
            JSON.stringify({ error: 'flag_id is required for close_flag action' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Update flag status
        const { error: flagError } = await supabaseAdmin
          .from('flags')
          .update({
            status: 'cleared',
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
            review_notes: body.notes || body.reason,
          })
          .eq('id', body.flag_id)
          .eq('account_id', body.account_id) // Ensure flag belongs to this account

        if (flagError) {
          throw new Error(`Failed to close flag: ${flagError.message}`)
        }

        // Audit the flag closure
        await supabaseAdmin.from('audit_logs').insert({
          user_id: userId,
          account_id: body.account_id,
          action: 'flag_cleared',
          request_id: requestId,
          reason: body.reason,
          details: {
            flag_id: body.flag_id,
            review_notes: body.notes || null,
            actor_role: actorRole,
          },
        })

        // Create trader-visible event for transparency
        await supabaseAdmin.from('account_events').insert({
          account_id: body.account_id,
          event_type: 'status_changed',
          request_id: requestId,
          event_data: {
            action_type: 'flag_cleared',
            flag_id: body.flag_id,
            explanation: 'A flag on your account has been reviewed and cleared.',
            actor_role: actorRole,
          },
        })

        result = { ...result, flag_id: body.flag_id, flag_closed: true }
        break
      }
    }

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Review action error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
