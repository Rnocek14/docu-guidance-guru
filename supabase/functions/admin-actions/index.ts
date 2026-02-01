import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ToggleIntakeRequest {
  action: 'toggle_intake'
  value: boolean
}

interface AdminActionRequest {
  action: string
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

    // Create client with user's auth for role checking
    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    // Verify user and get claims
    const token = authHeader.replace('Bearer ', '')
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token)
    
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = claimsData.claims.sub as string

    // Create service role client for privileged operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

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
      const value = body.value as boolean

      // Update system setting
      const { error: updateError } = await supabaseAdmin
        .from('system_settings')
        .update({ 
          value: value, 
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('key', 'global_intake_active')

      if (updateError) {
        throw new Error(`Failed to update setting: ${updateError.message}`)
      }

      // Create audit log entry (server-side, bypasses RLS)
      const { error: auditError } = await supabaseAdmin
        .from('audit_logs')
        .insert({
          user_id: userId,
          action: value ? 'intake_resumed' : 'intake_paused',
          details: { global_intake: value },
          reason: `Global intake ${value ? 'resumed' : 'paused'} by admin`,
        })

      if (auditError) {
        console.error('Failed to create audit log:', auditError)
        // Don't fail the request if audit log fails, but log it
      }

      return new Response(
        JSON.stringify({ success: true, intake_active: value }),
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
