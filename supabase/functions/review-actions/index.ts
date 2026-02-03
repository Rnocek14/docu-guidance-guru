import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ReviewActionRequest {
  action: 'confirm_failure' | 'clear_breach' | 'escalate'
  account_id: string
  reason: string
  notes?: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight
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

    // Check if user has risk_officer or admin role
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

    const userRole = roleData[0].role

    // Parse request body
    const body: ReviewActionRequest = await req.json()

    if (!body.account_id || !body.action || !body.reason) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: account_id, action, reason' }),
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

    const previousStatus = account.status
    const requestId = crypto.randomUUID()
    let newStatus: string
    let auditAction: string
    let eventType: string

    switch (body.action) {
      case 'confirm_failure':
        // Can only confirm failure from breached_detected or under_review
        if (!['breached_detected', 'under_review'].includes(account.status)) {
          return new Response(
            JSON.stringify({ error: `Cannot confirm failure from status: ${account.status}` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        newStatus = 'failed_confirmed'
        auditAction = 'failure_confirmed'
        eventType = 'failure_confirmed'
        break

      case 'clear_breach':
        // Can only clear from breached_detected
        if (account.status !== 'breached_detected') {
          return new Response(
            JSON.stringify({ error: `Cannot clear breach from status: ${account.status}` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        newStatus = 'active'
        auditAction = 'status_changed'
        eventType = 'status_changed'
        break

      case 'escalate':
        // Risk officers can escalate to admin review
        if (!['breached_detected', 'active'].includes(account.status)) {
          return new Response(
            JSON.stringify({ error: `Cannot escalate from status: ${account.status}` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        newStatus = 'under_review'
        auditAction = 'status_changed'
        eventType = 'status_changed'
        break

      default:
        return new Response(
          JSON.stringify({ error: 'Unknown action' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

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

    // Create audit log entry (immutable, internal)
    const { error: auditError } = await supabaseAdmin
      .from('audit_logs')
      .insert({
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
          reviewer_role: userRole,
        },
      })

    if (auditError) {
      console.error('Failed to create audit log:', auditError)
    }

    // Create account event (trader-visible timeline)
    const eventExplanation = {
      confirm_failure: `Your account has been reviewed and the breach has been confirmed. Reason: ${body.reason}`,
      clear_breach: `The detected breach has been cleared after review. Reason: ${body.reason}`,
      escalate: `Your account has been escalated for additional review. Reason: ${body.reason}`,
    }

    const { error: eventError } = await supabaseAdmin
      .from('account_events')
      .insert({
        account_id: body.account_id,
        event_type: eventType,
        request_id: requestId,
        event_data: {
          previous_status: previousStatus,
          new_status: newStatus,
          reason: body.reason,
          explanation: eventExplanation[body.action],
        },
      })

    if (eventError) {
      console.error('Failed to create account event:', eventError)
    }

    // If confirming violations, update them too
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

    return new Response(
      JSON.stringify({
        success: true,
        account_id: body.account_id,
        previous_status: previousStatus,
        new_status: newStatus,
        action: body.action,
        request_id: requestId,
      }),
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
