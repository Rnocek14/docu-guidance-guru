import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface FingerprintRequest {
  fingerprint_hash: string
  fingerprint_components: {
    canvas_hash?: string
    webgl_hash?: string
    audio_hash?: string
    fonts_hash?: string
    screen_resolution?: string
    timezone?: string
    language?: string
    platform?: string
    user_agent?: string
    hardware_concurrency?: number
    device_memory?: number
    touch_support?: boolean
  }
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

    // Parse request body
    const body: FingerprintRequest = await req.json()

    if (!body.fingerprint_hash || !body.fingerprint_components) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: fingerprint_hash, fingerprint_components' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Extract IP and geo info from request
    const clientIp = req.headers.get('cf-connecting-ip') || 
                     req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                     req.headers.get('x-real-ip')

    const country = req.headers.get('cf-ipcountry')
    const asn = req.headers.get('cf-asn')

    // Check for VPN/proxy indicators
    const isVpn = checkVpnIndicators(asn, body.fingerprint_components)

    // Check if this fingerprint exists for OTHER users (potential multi-account)
    const { data: existingFingerprints } = await supabaseAdmin
      .from('device_fingerprints')
      .select('id, user_id, cluster_id')
      .eq('fingerprint_hash', body.fingerprint_hash)
      .neq('user_id', userId)

    let clusterId: string | null = null

    // If fingerprint matches other users, link to same cluster.
    // NOTE: This function only handles CLUSTER MEMBERSHIP (linking fingerprints
    // to clusters). Risk scoring is owned by the evaluate_cluster_risk RPC/trigger
    // which is the canonical owner of identity_clusters.risk_score.
    // DO NOT update risk_score or is_flagged here — that creates a dual-writer bug.
    if (existingFingerprints && existingFingerprints.length > 0) {
      const existingClusterId = existingFingerprints[0].cluster_id

      if (existingClusterId) {
        clusterId = existingClusterId
        // Do NOT update risk_score here — evaluate_cluster_risk is canonical owner
      } else {
        // Create new cluster for linked accounts (with default risk_score=0)
        // The evaluate_cluster_risk RPC will score it on next evaluation cycle
        const { data: newCluster } = await supabaseAdmin
          .from('identity_clusters')
          .insert({
            cluster_name: `Auto-detected cluster ${new Date().toISOString().slice(0, 10)}`,
            risk_score: 0,
            is_flagged: false,
            flag_reason: null,
          })
          .select('id')
          .single()

        if (newCluster) {
          clusterId = newCluster.id

          // Update existing fingerprints to link to cluster
          await supabaseAdmin
            .from('device_fingerprints')
            .update({ cluster_id: clusterId })
            .in('id', existingFingerprints.map(f => f.id))
        }
      }
    }

    // Upsert fingerprint for this user
    const { data: fingerprint, error: upsertError } = await supabaseAdmin
      .from('device_fingerprints')
      .upsert({
        user_id: userId,
        fingerprint_hash: body.fingerprint_hash,
        fingerprint_components: body.fingerprint_components,
        ip_address: clientIp,
        asn: asn,
        country_code: country,
        is_vpn: isVpn,
        cluster_id: clusterId,
        last_seen_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,fingerprint_hash',
      })
      .select('id, cluster_id, is_vpn')
      .single()

    if (upsertError) {
      console.error('Fingerprint upsert error:', upsertError)
      return new Response(
        JSON.stringify({ error: 'Failed to store fingerprint' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // FIX: Use atomic RPC for seen_count increment (not .update with rpc())
    await supabaseAdmin.rpc('bump_fingerprint_seen', { _id: fingerprint.id })

    return new Response(
      JSON.stringify({
        success: true,
        fingerprint_id: fingerprint.id,
        cluster_linked: !!clusterId,
        vpn_detected: isVpn,
        shared_with_other_users: existingFingerprints ? existingFingerprints.length > 0 : false
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Fingerprint collection error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// Simple VPN detection heuristics
function checkVpnIndicators(
  asn: string | null, 
  components: FingerprintRequest['fingerprint_components']
): boolean {
  // Known datacenter/VPN ASN patterns
  const vpnAsnPatterns = [
    'AS14061', // DigitalOcean
    'AS16276', // OVH
    'AS14618', // Amazon AWS
    'AS15169', // Google Cloud
    'AS8075',  // Microsoft Azure
    'AS13335', // Cloudflare
    'AS20473', // Vultr
    'AS63949', // Linode
    'AS46664', // VolumeDrive (VPN)
    'AS9009',  // M247 (VPN)
    'AS206092', // NordVPN
    'AS212238', // ExpressVPN
  ]

  if (asn && vpnAsnPatterns.some(pattern => asn.includes(pattern.replace('AS', '')))) {
    return true
  }

  // Timezone mismatch heuristic
  // (Would need IP geolocation to compare - simplified here)

  return false
}
