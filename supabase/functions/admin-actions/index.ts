import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AdminActionRequest {
  action: string
  value?: boolean
  idempotency_key?: string
  [key: string]: unknown
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

    const jwt = authHeader.replace('Bearer ', '')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // FIX 1: Use anon key + JWT for proper token validation (canonical pattern)
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })

    const { data: userData, error: userError } = await supabaseUser.auth.getUser()

    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = userData.user.id

    // Create service role client for privileged operations (role check + DB writes)
    const supabaseAdmin = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // FIX 6: Strict role check - must be exactly true
    const { data: isAdmin, error: roleError } = await supabaseAdmin.rpc('has_role', {
      _user_id: userId,
      _role: 'admin',
    })

    if (roleError || isAdmin !== true) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Admin role required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: AdminActionRequest = await req.json()
    const requestId = crypto.randomUUID()

    if (body.action === 'audit_log') {
      // Generic audit logging for admin actions (cohort updates, etc.)
      // This action FAILS if audit insert fails (audit IS the operation)
      const { audit_action, target_type, target_id, reason, details, account_id, idempotency_key } = body as {
        audit_action: string
        target_type: string
        target_id: string
        reason?: string
        details?: Record<string, unknown>
        account_id?: string
        idempotency_key?: string
      }

      if (!audit_action || !target_type || !target_id) {
        return new Response(
          JSON.stringify({ error: 'audit_action, target_type, and target_id are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // FIX 1: Require idempotency_key from client for audit_log action
      if (!idempotency_key) {
        return new Response(
          JSON.stringify({ error: 'idempotency_key is required for audit_log action' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const auditRow = {
        user_id: userId,
        account_id: account_id || null,
        action: audit_action,
        reason: reason ?? null,
        details: {
          actor_user_id: userId,
          target_type,
          target_id,
          ...details,
        },
        request_id: requestId,
        idempotency_key,
        ip_address: req.headers.get('x-forwarded-for')?.split(',')[0] || null,
        user_agent: req.headers.get('user-agent') || null,
      }

      // FIX 4: Use upsert with ignoreDuplicates instead of brittle error code check
      const { error: insertError } = await supabaseAdmin
        .from('audit_logs')
        .upsert(auditRow, { onConflict: 'idempotency_key', ignoreDuplicates: true })

      if (insertError) {
        console.error('Audit log insert error:', insertError)
        return new Response(
          JSON.stringify({ error: 'audit_failed', message: insertError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({ success: true, request_id: requestId }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (body.action === 'toggle_intake') {
      const newValue = body.value as boolean

      // Get current value first for idempotent audit logging
      const { data: currentSetting } = await supabaseAdmin
        .from('system_settings')
        .select('value, id')
        .eq('key', 'global_intake_active')
        .single()

      const previousValue = currentSetting?.value
      const settingId = currentSetting?.id

      // Update system setting
      const { error: updateError } = await supabaseAdmin
        .from('system_settings')
        .update({ 
          value: newValue, 
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('key', 'global_intake_active')

      if (updateError) {
        throw new Error(`Failed to update setting: ${updateError.message}`)
      }

      // FIX 3: Deterministic idempotency key from stable inputs
      // If client provides key, use it; otherwise derive from (action, newValue, previousValue, settingId)
      const auditIdempotencyKey = body.idempotency_key 
        ?? `toggle_intake:${newValue}:${String(previousValue)}:${settingId ?? 'unknown'}`
      
      // Best-effort audit log - don't fail the action if audit fails
      try {
        await supabaseAdmin
          .from('audit_logs')
          .upsert({
            user_id: userId,
            action: newValue ? 'intake_resumed' : 'intake_paused',
            details: { 
              previous_value: previousValue,
              new_value: newValue,
              setting_key: 'global_intake_active'
            },
            reason: `Global intake ${newValue ? 'resumed' : 'paused'} by admin`,
            request_id: requestId,
            idempotency_key: auditIdempotencyKey,
          }, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      } catch (auditErr) {
        // Log but don't fail - the action succeeded
        console.error('Failed to create audit log (non-blocking):', auditErr)
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          intake_active: newValue,
          previous_value: previousValue,
          request_id: requestId,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Unknown action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Admin action error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
