import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AdminActionRequest {
  action: string
  value?: boolean
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

    const token = authHeader.replace('Bearer ', '')

    // Create service role client for privileged operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // FIX 2: Use getUser() instead of getClaims() for token validation
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = userData.user.id

    // Check if user is admin
    const { data: roleData } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .single()

    if (!roleData) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Admin role required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: AdminActionRequest = await req.json()

    if (body.action === 'toggle_intake') {
      const newValue = body.value as boolean

      // FIX 3: Get current value first for idempotent audit logging
      const { data: currentSetting } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'global_intake_active')
        .single()

      const previousValue = currentSetting?.value

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

      // FIX 3: Idempotent audit log with previous and new values
      const { error: auditError } = await supabaseAdmin
        .from('audit_logs')
        .insert({
          user_id: userId,
          action: newValue ? 'intake_resumed' : 'intake_paused',
          details: { 
            previous_value: previousValue,
            new_value: newValue,
            setting_key: 'global_intake_active'
          },
          reason: `Global intake ${newValue ? 'resumed' : 'paused'} by admin`,
        })

      if (auditError) {
        console.error('Failed to create audit log:', auditError)
        // Log but don't fail - the action succeeded
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          intake_active: newValue,
          previous_value: previousValue 
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
