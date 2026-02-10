import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// All payout actions are admin-only
type PayoutAction = 'approve' | 'reject' | 'request_more_info' | 'initiate_payment'

interface PayoutActionRequest {
  action: PayoutAction
  payout_id: string
  reason?: string           // Required for reject, request_more_info
  provider?: string         // Required for initiate_payment
  idempotency_key?: string
  skip_fraud_check?: boolean // Admin override for fraud checks (logged)
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
  initiate_payment: {
    from: ['approved'],
    to: 'payment_initiated'
  },
}

// Tolerance for amount verification (cents)
const AMOUNT_TOLERANCE = 0.01

// Helper: Generate deterministic idempotency key via SHA-256
async function generateDeterministicKey(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex.slice(0, 48) // First 48 chars for reasonable length
}

// FIX C: All audit inserts now use idempotency_key for deduplication
// deno-lint-ignore no-explicit-any
async function insertAuditLog(supabase: any, data: any): Promise<{ inserted: boolean }> {
  const { data: result, error } = await supabase
    .from('audit_logs')
    .upsert(data, { 
      onConflict: 'idempotency_key',
      ignoreDuplicates: true 
    })
    .select('id')
  
  if (error) {
    console.error('Audit log insert error:', error)
    return { inserted: false }
  }
  return { inserted: result && result.length > 0 }
}

// Helper: Normalize payment reference for idempotency
function normalizePaymentRef(s: string): string {
  return s.trim().replace(/\s+/g, '_').toUpperCase()
}

// Helper: Normalize reason text for idempotency (reject/request_more_info)
function normalizeReason(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

// Helper: String-safe amount to cents conversion
// Handles both number and string inputs, avoids floating point weirdness
function amountToCents(v: string | number): number {
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim()
  const m = s.match(/^(-?\d+)(?:\.(\d*))?$/)
  if (!m) throw new Error('invalid_amount')
  const dollars = parseInt(m[1], 10)
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2)
  const cents = parseInt(frac, 10)
  return dollars * 100 + (dollars < 0 ? -cents : cents)
}

// Helper: Normalize event_type to safe charset (snake_case, no spaces, collapsed underscores)
function normalizeEventType(eventType: string): string {
  return eventType
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// deno-lint-ignore no-explicit-any
async function insertAccountEvent(supabase: any, data: any): Promise<{ inserted: boolean }> {
  // account_events now has idempotency_key NOT NULL UNIQUE
  const { data: result, error } = await supabase
    .from('account_events')
    .upsert(data, { 
      onConflict: 'idempotency_key',
      ignoreDuplicates: true 
    })
    .select('id')
  
  if (error) {
    console.error('Account event insert error:', error)
    return { inserted: false }
  }
  return { inserted: result && result.length > 0 }
}

// deno-lint-ignore no-explicit-any
async function createFraudReview(supabase: any, data: any): Promise<string | null> {
  const { data: result, error } = await supabase
    .from('fraud_reviews')
    .insert(data)
    .select('id')
    .single()
  
  if (error) {
    console.error('Fraud review insert error:', error)
    return null
  }
  return result?.id || null
}

interface EligibilityResult {
  eligible: boolean
  reason?: string
  max_eligible_amount?: number
  realized_profit?: number
  payout_split_percent?: number
  max_payout_percent?: number
  max_payout_absolute?: number | null
  days_since_last_payout?: number
  trading_days_since_payout?: number
  pending_violations?: number
  pending_flags?: number
  pending_fraud_reviews?: number
  current_status?: string
  days_remaining?: number
  required_cooldown_days?: number
  required_trading_days?: number
}

interface CorrelationResult {
  has_correlations: boolean
  correlation_count: number
  correlations: Array<{
    other_account_id: string
    other_account_number: string
    match_count: number
    correlation_type: 'opposite_side' | 'same_side'
    sample_trades: unknown[]
  }>
  error?: string
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

    const jwt = authHeader.replace('Bearer ', '')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // FIX A: Use anon key + JWT for proper token validation (canonical pattern)
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

    // Create service role client for privileged operations
    const supabaseAdmin = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // FIX B: Strict role check via has_role RPC (must be exactly true)
    const { data: isAdmin, error: roleError } = await supabaseAdmin.rpc('has_role', {
      _user_id: userId,
      _role: 'admin',
    })

    if (roleError || isAdmin !== true) {
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

    if (body.action === 'initiate_payment' && !body.provider) {
      return new Response(
        JSON.stringify({ error: 'Provider is required for initiate_payment' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get payout with account info
    const { data: payout, error: payoutError } = await supabaseAdmin
      .from('payouts')
      .select('*, accounts!inner(id, status, account_number, current_balance, total_pnl, starting_balance, user_id, cohort_id)')
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

    // Normalize join result
    const account = Array.isArray(payout.accounts) ? payout.accounts[0] : payout.accounts
    if (!account) {
      return new Response(
        JSON.stringify({ error: 'Account data not found for payout' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Convert amount from Postgres DECIMAL to number
    const submittedAmount = Number(payout.amount)
    if (isNaN(submittedAmount)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payout amount' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate FULLY DETERMINISTIC idempotency keys per action type
    // CRITICAL: Never include random UUIDs - retries must produce the same key
    let effectiveIdempotencyKey: string
    
    if (body.idempotency_key) {
      // Client provided key - use as-is
      effectiveIdempotencyKey = body.idempotency_key
    } else {
      // Generate deterministic key from stable action-specific inputs
      const amountCents = amountToCents(submittedAmount)
      let keyInput: string
      switch (body.action) {
        case 'initiate_payment': {
          const normalizedProvider = (body.provider ?? '').trim().toLowerCase()
          keyInput = `audit:initiate_payment:${body.payout_id}:${normalizedProvider}:${amountCents}`
          break
        }
        case 'approve':
          keyInput = `audit:approve:${body.payout_id}:${amountCents}`
          break
        case 'reject': {
          const normalizedReason = normalizeReason(body.reason ?? '')
          keyInput = `audit:reject:${body.payout_id}:${normalizedReason}`
          break
        }
        case 'request_more_info': {
          const normalizedReason = normalizeReason(body.reason ?? '')
          keyInput = `audit:more_info:${body.payout_id}:${normalizedReason}`
          break
        }
        default:
          keyInput = `audit:payout:${body.payout_id}:${body.action}`
      }
      effectiveIdempotencyKey = 'audit.' + await generateDeterministicKey(keyInput)
    }
    
    // Use the same key for both audit and event deduplication
    const requestId = effectiveIdempotencyKey
    const previousStatus = payout.status
    const newStatus = transition.to

    // =============================================
    // P0-B: JURISDICTION CHECK (using canonical RPC - single source of truth)
    // =============================================
    
    // Check jurisdiction for payout_send (admin approving = sending)
    if (body.action === 'approve' || body.action === 'initiate_payment') {
      // First try to resolve jurisdiction if unknown
      const { data: resolveResult, error: resolveError } = await supabaseAdmin
        .rpc('resolve_user_jurisdiction', { _user_id: account.user_id })
      
      // Handle resolver failure with clear message to staff
      if (resolveError) {
        console.error('Jurisdiction resolver error:', resolveError)
      }
      
      if (resolveResult && !resolveResult.success) {
        // Specific message for no geo signals
        if (resolveResult.reason === 'no_geo_signals') {
          return new Response(
            JSON.stringify({ 
              error: 'Payout blocked: No geo signals recorded for user',
              hint: 'Record billing country, KYC country, or IP country first. User may need to complete verification.',
              user_id: account.user_id
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
      
      // Use the canonical service-role RPC for jurisdiction check
      const { data: jurisdictionCheck, error: jurisdictionError } = await supabaseAdmin
        .rpc('assert_user_jurisdiction_allowed', { 
          _user_id: account.user_id, 
          p_action: 'payout_send' 
        })

      if (jurisdictionError) {
        console.error('Jurisdiction check error:', jurisdictionError)
        return new Response(
          JSON.stringify({ 
            error: 'Payout blocked: Jurisdiction check failed',
            details: jurisdictionError.message
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (!jurisdictionCheck?.allowed) {
        const reason = jurisdictionCheck?.reason || 'jurisdiction_check_failed'
        const hints: Record<string, string> = {
          'jurisdiction_unknown': 'No geo signals — record billing/KYC/IP country first',
          'kyc_required': 'User must complete identity verification before payouts',
          'country_blocked': 'User country is on blocklist',
          'payouts_not_allowed': 'Payouts disabled for this region',
          'no_rules_for_country': 'Country not in allowlist — add jurisdiction rules first'
        }
        
        return new Response(
          JSON.stringify({ 
            error: 'Payout blocked: ' + reason,
            country: jurisdictionCheck?.country,
            hint: hints[reason] || 'Payouts not available in user region'
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // =============================================
    // P0-B: GEO-MISMATCH HOLD CHECK (on approve)
    // =============================================
    
    let geoMismatchApplied = false
    
    if (body.action === 'approve') {
      // Check for geo mismatches and apply hold if found
      const { data: mismatchResult } = await supabaseAdmin
        .rpc('check_geo_mismatch', { _user_id: account.user_id })

      if (mismatchResult?.has_mismatch) {
        // Check if already on hold
        const { data: profileData } = await supabaseAdmin
          .from('profiles')
          .select('payouts_hold, payouts_hold_reason')
          .eq('user_id', account.user_id)
          .single()

        if (!profileData?.payouts_hold) {
          // Apply hold
          const { data: holdResult } = await supabaseAdmin
            .rpc('apply_geo_mismatch_hold', { _user_id: account.user_id })

          if (holdResult?.hold_applied) {
            geoMismatchApplied = true
            
            // Block the approval - requires manual hold release first
            return new Response(
              JSON.stringify({ 
                error: 'Payout blocked: Geo mismatch detected',
                hold_reason: holdResult.hold_reason,
                mismatch_details: holdResult.mismatch_details,
                hint: 'User has conflicting location signals (IP/KYC/billing). Manual review and hold release required before approval.',
                request_id: holdResult.request_id
              }),
              { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
        } else {
          // Already on hold - block
          return new Response(
            JSON.stringify({ 
              error: 'Payout blocked: User on geo-mismatch hold',
              hold_reason: profileData.payouts_hold_reason,
              hint: 'Release hold via admin workflow before approving payout'
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
    }

    // =============================================
    // RISK THROTTLE: Eligibility delay enforcement
    // =============================================

    if (body.action === 'approve') {
      const { data: throttle } = await supabaseAdmin
        .from('risk_throttle_state')
        .select('eligibility_delay_bonus_days, state')
        .eq('id', '00000000-0000-0000-0000-000000000002')
        .single()

      if (throttle && throttle.eligibility_delay_bonus_days > 0) {
        // Guard: requested_at must exist for date math
        if (!payout.requested_at) {
          return new Response(
            JSON.stringify({ code: 'MISSING_REQUESTED_AT', error: 'Payout has no requested_at timestamp' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const requestedAt = new Date(payout.requested_at)
        const now = new Date()
        const daysSinceRequest = (now.getTime() - requestedAt.getTime()) / (1000 * 60 * 60 * 24)

        if (daysSinceRequest < throttle.eligibility_delay_bonus_days) {
          const daysRemaining = Math.ceil(throttle.eligibility_delay_bonus_days - daysSinceRequest)
          return new Response(
            JSON.stringify({
              code: 'RISK_THROTTLE_DELAY_ACTIVE',
              error: 'Payout approval delayed by risk throttle',
              throttle_state: throttle.state,
              bonus_delay_days: throttle.eligibility_delay_bonus_days,
              days_remaining: daysRemaining,
              hint: `Extended verification period active (${throttle.state}). Approval available in ~${daysRemaining} day(s).`,
            }),
            { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
    }

    // =============================================
    // P0 BLOCKER: SERVER-SIDE ELIGIBILITY VERIFICATION
    // =============================================
    
    let eligibility: EligibilityResult | null = null
    let correlations: CorrelationResult | null = null
    let fraudReviewId: string | null = null
    let calculatedEligibleAmount: number | null = null

    // Only run full verification on approval (the critical path)
    if (body.action === 'approve') {
      
      // 1. VERIFY PAYOUT ELIGIBILITY
      const { data: eligibilityData, error: eligibilityError } = await supabaseAdmin
        .rpc('calculate_payout_eligibility', { _account_id: payout.account_id })
      
      if (eligibilityError) {
        console.error('Eligibility check error:', eligibilityError)
        return new Response(
          JSON.stringify({ error: 'Failed to verify payout eligibility', details: eligibilityError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      eligibility = eligibilityData as EligibilityResult
      
      if (!eligibility.eligible) {
        return new Response(
          JSON.stringify({ 
            error: 'Payout not eligible',
            reason: eligibility.reason,
            details: eligibility
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      calculatedEligibleAmount = eligibility.max_eligible_amount || 0
      
      // 2. VERIFY AMOUNT MATCHES SERVER CALCULATION
      if (Math.abs(submittedAmount - calculatedEligibleAmount) > AMOUNT_TOLERANCE) {
        // Check if submitted is LESS than eligible (allowed) or MORE (blocked)
        if (submittedAmount > calculatedEligibleAmount) {
          return new Response(
            JSON.stringify({ 
              error: 'Submitted amount exceeds eligible payout',
              submitted_amount: submittedAmount,
              calculated_eligible_amount: calculatedEligibleAmount,
              difference: submittedAmount - calculatedEligibleAmount,
              hint: 'Amount must not exceed server-calculated maximum'
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        // If less, that's fine - trader can request partial payout
      }
      
      // 3. CHECK CROSS-ACCOUNT CORRELATIONS (MVP fraud detection)
      // Detects both opposite-side (hedging) and same-side (copy trading) patterns
      const { data: correlationData, error: correlationError } = await supabaseAdmin
        .rpc('detect_trade_correlations', { 
          _account_id: payout.account_id,
          _time_window_seconds: 60,
          _min_match_count: 3  // FIX: renamed parameter
        })
      
      if (correlationError) {
        console.error('Correlation check error:', correlationError)
        // Non-fatal: log but don't block
      } else {
        correlations = correlationData as CorrelationResult
        
        if (correlations.has_correlations && !body.skip_fraud_check) {
          // Create fraud review and block approval
          fraudReviewId = await createFraudReview(supabaseAdmin, {
            entity_type: 'payout',
            entity_id: body.payout_id,
            review_type: 'correlation',
            severity: correlations.correlation_count >= 3 ? 'critical' : 'high',
            auto_block: true,
            details: {
              correlations: correlations.correlations,
              submitted_amount: submittedAmount,
              account_id: payout.account_id,
              triggered_at: new Date().toISOString()
            },
            request_id: requestId
          })
          
          return new Response(
            JSON.stringify({ 
              error: 'Payout blocked: Cross-account correlation detected',
              fraud_review_id: fraudReviewId,
              correlation_count: correlations.correlation_count,
              hint: 'Manual review required. Use skip_fraud_check=true to override (will be logged).',
              correlations: correlations.correlations.map(c => ({
                other_account: c.other_account_number,
                match_count: c.match_count,
                type: c.correlation_type
              }))
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
      
      // 3b. CHECK CROSS-INSTRUMENT HEDGING (ES vs NQ, CL vs BZ, etc.)
      // Catches adversarial hedging across related instruments that same-symbol detection misses
      const { data: crossInstrumentData, error: crossInstrumentError } = await supabaseAdmin
        .rpc('detect_cross_instrument_correlations', {
          _account_id: payout.account_id,
          _time_window_seconds: 120,
          _min_match_count: 2
        })
      
      if (crossInstrumentError) {
        console.error('Cross-instrument correlation check error:', crossInstrumentError)
      } else if (crossInstrumentData?.has_correlations && !body.skip_fraud_check) {
        fraudReviewId = await createFraudReview(supabaseAdmin, {
          entity_type: 'payout',
          entity_id: body.payout_id,
          review_type: 'cross_instrument_hedge',
          severity: crossInstrumentData.correlation_count >= 3 ? 'critical' : 'high',
          auto_block: true,
          details: {
            correlations: crossInstrumentData.correlations,
            submitted_amount: submittedAmount,
            account_id: payout.account_id,
            triggered_at: new Date().toISOString()
          },
          request_id: requestId
        })
        
        return new Response(
          JSON.stringify({
            error: 'Payout blocked: Cross-instrument hedging detected',
            fraud_review_id: fraudReviewId,
            correlation_count: crossInstrumentData.correlation_count,
            hint: 'Opposing positions on correlated instruments (e.g., ES vs NQ) detected across accounts. Manual review required.',
            correlations: crossInstrumentData.correlations
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      // 4. CHECK FOR DEVICE FINGERPRINT MATCHES (if available)
      // FIX: Two-step query - Supabase JS doesn't support subqueries
      const { data: userFingerprints } = await supabaseAdmin
        .from('device_fingerprints')
        .select('fingerprint_hash')
        .eq('user_id', account.user_id)
      
      const userHashes = (userFingerprints ?? []).map(fp => fp.fingerprint_hash)
      
      if (userHashes.length > 0) {
        const { data: fingerprintMatches } = await supabaseAdmin
          .from('device_fingerprints')
          .select('fingerprint_hash, user_id, cluster_id')
          .in('fingerprint_hash', userHashes)
          .neq('user_id', account.user_id)
          .limit(10)
        
        // If fingerprint matches found for other users, flag for review (but don't auto-block)
        if (fingerprintMatches && fingerprintMatches.length > 0 && !body.skip_fraud_check) {
          fraudReviewId = await createFraudReview(supabaseAdmin, {
            entity_type: 'payout',
            entity_id: body.payout_id,
            review_type: 'device_match',
            severity: 'medium',
            auto_block: false,
            details: {
              matching_users: fingerprintMatches.length,
              matching_hashes: fingerprintMatches.map(m => m.fingerprint_hash),
              submitted_amount: submittedAmount,
              account_id: payout.account_id
            },
            request_id: requestId
          })
          // Don't block, just flag
        }
      }
      
      // 5. CHECK FOR PAYOUT METHOD REUSE (if method linked)
      if (payout.payout_method_id) {
        const { data: methodData } = await supabaseAdmin
          .from('payout_methods')
          .select('method_hash, is_blocked, block_reason')
          .eq('id', payout.payout_method_id)
          .single()
        
        if (methodData?.is_blocked) {
          return new Response(
            JSON.stringify({ 
              error: 'Payout method is blocked',
              reason: methodData.block_reason || 'This payout method has been flagged'
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        
        // Check if method is used by other users
        const { data: methodReuse } = await supabaseAdmin
          .from('payout_methods')
          .select('user_id')
          .eq('method_hash', methodData?.method_hash)
          .neq('user_id', account.user_id)
          .limit(1)
        
        if (methodReuse && methodReuse.length > 0 && !body.skip_fraud_check) {
          fraudReviewId = await createFraudReview(supabaseAdmin, {
            entity_type: 'payout',
            entity_id: body.payout_id,
            review_type: 'method_reuse',
            severity: 'high',
            auto_block: true,
            details: {
              method_reused_by_users: methodReuse.length,
              submitted_amount: submittedAmount,
              account_id: payout.account_id
            },
            request_id: requestId
          })
          
          return new Response(
            JSON.stringify({ 
              error: 'Payout blocked: Payment method used by another user',
              fraud_review_id: fraudReviewId,
              hint: 'Manual review required. Use skip_fraud_check=true to override (will be logged).'
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
      
      // Log if admin is skipping fraud checks (separate audit entry with own idempotency)
      if (body.skip_fraud_check) {
        const skipFraudKey = await generateDeterministicKey(`skip_fraud:${body.payout_id}:${submittedAmount}`)
        await insertAuditLog(supabaseAdmin, {
          user_id: userId,
          account_id: payout.account_id,
          action: 'status_changed',
          request_id: crypto.randomUUID(),
          idempotency_key: skipFraudKey,
          reason: 'Admin skipped fraud checks for payout approval',
          details: {
            payout_id: body.payout_id,
            skip_reason: 'admin_override',
            correlations_found: correlations?.has_correlations || false,
            geo_mismatch_applied: geoMismatchApplied,
            actor_role: 'admin',
          },
        })
      }
    }

    // =============================================
    // ECONOMIC SAFETY GATE (fail-closed)
    // =============================================
    // Must pass before any approval. Aggregates pass rate, simulation,
    // reserve, payout volume, reset rate signals into a single verdict.
    
    let econGateResult: { status: string; reasons: unknown[]; metrics: Record<string, unknown>; recommended_actions: string[] } | null = null
    
    if (body.action === 'approve') {
      const { data: econData, error: econError } = await supabaseAdmin
        .rpc('get_econ_guardrail_status', { _window_days: 30 })
      
      if (econError) {
        console.error('Econ guardrail RPC error:', econError)
        // Fail-closed: if we can't check economics, block
        return new Response(
          JSON.stringify({
            error: 'Payout blocked: Economic safety gate unavailable',
            reason_code: 'ECON_GATE_UNAVAILABLE',
            hint: 'The get_econ_guardrail_status RPC failed. This is a fail-closed gate — payout approvals are blocked until it succeeds.',
            details: econError.message,
          }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      econGateResult = econData as typeof econGateResult
      
      if (econGateResult?.status === 'block') {
        return new Response(
          JSON.stringify({
            error: 'Payout blocked: Economic safety gate',
            reason_code: 'ECON_GATE_BLOCK',
            econ_status: econGateResult.status,
            reasons: econGateResult.reasons,
            metrics: econGateResult.metrics,
            recommended_actions: econGateResult.recommended_actions,
            hint: 'Platform economics are out of spec. Resolve the listed issues before approving payouts.',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      // WARN: log but allow (staff can see warning in response)
      if (econGateResult?.status === 'warn') {
        console.warn('Econ guardrail WARN:', JSON.stringify(econGateResult.reasons))
      }
    }

    // =============================================
    // RESERVE-AWARE APPROVAL GATE (feature-flagged)
    // =============================================
    
    if (body.action === 'approve') {
      const { data: reserveConfig } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'reserve_aware_approval')
        .single()
      
      const config = reserveConfig?.value as {
        enabled?: boolean
        min_reserve_after_approval?: number
        block_if_simulated_loss_prob_above?: number
        last_simulation_run_id?: string | null
      } | null
      
      // FAIL-CLOSED: Missing config or disabled gate blocks approvals.
      // This is intentional — a misconfiguration must never silently bypass
      // the reserve safety gate. Support pain > insolvency.
      if (!config) {
        return new Response(
          JSON.stringify({
            error: 'Payout blocked: Reserve gate configuration missing',
            reason_code: 'RESERVE_CONFIG_MISSING',
            hint: 'Add a "reserve_aware_approval" row to system_settings with enabled=true, min_reserve_after_approval, and block_if_simulated_loss_prob_above.',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      if (config.enabled !== true) {
        return new Response(
          JSON.stringify({
            error: 'Payout blocked: Reserve safety gate is disabled',
            reason_code: 'RESERVE_GATE_DISABLED',
            hint: 'Set enabled=true in system_settings.reserve_aware_approval to allow payout approvals.',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      // STRICT SHAPE VALIDATION: Any malformed field = fail-closed.
      // Prevents NaN, undefined, or wrong types from silently disabling checks.
      {
        const minReserve = config.min_reserve_after_approval
        const lossThreshold = config.block_if_simulated_loss_prob_above
        if (typeof minReserve !== 'number' || !isFinite(minReserve) || minReserve < 0) {
          return new Response(
            JSON.stringify({
              error: 'Payout blocked: Reserve gate config malformed',
              reason_code: 'RESERVE_CONFIG_MISSING',
              hint: 'min_reserve_after_approval must be a finite number >= 0.',
              field: 'min_reserve_after_approval',
              value: minReserve,
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        if (typeof lossThreshold !== 'number' || !isFinite(lossThreshold) || lossThreshold < 0 || lossThreshold > 1) {
          return new Response(
            JSON.stringify({
              error: 'Payout blocked: Reserve gate config malformed',
              reason_code: 'RESERVE_CONFIG_MISSING',
              hint: 'block_if_simulated_loss_prob_above must be a number between 0 and 1.',
              field: 'block_if_simulated_loss_prob_above',
              value: lossThreshold,
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }

      // SIMULATION STALENESS CHECK: Prevent the reserve gate from operating
      // on stale simulation data. If the gate references a simulation run,
      // that run must exist AND be recent (within 7 days).
      // Missing or stale = fail-closed with distinct reason code.
      {
        const simRunId = config.last_simulation_run_id
        if (!simRunId || typeof simRunId !== 'string') {
          return new Response(
            JSON.stringify({
              error: 'Payout blocked: No simulation run linked to reserve gate',
              reason_code: 'RESERVE_SIMULATION_STALE',
              hint: 'Run a Monte Carlo simulation to generate a current risk assessment. The run ID will be auto-linked to the reserve gate.',
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        const { data: simRun, error: simErr } = await supabaseAdmin
          .from('simulation_runs')
          .select('id, created_at, status')
          .eq('id', simRunId)
          .single()

        if (simErr || !simRun) {
          return new Response(
            JSON.stringify({
              error: 'Payout blocked: Referenced simulation run not found',
              reason_code: 'RESERVE_SIMULATION_STALE',
              hint: `Simulation run ${simRunId} does not exist. Run a new simulation.`,
              simulation_run_id: simRunId,
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        const MAX_SIMULATION_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
        const simAge = Date.now() - new Date(simRun.created_at).getTime()
        if (simAge > MAX_SIMULATION_AGE_MS) {
          return new Response(
            JSON.stringify({
              error: 'Payout blocked: Simulation data too old',
              reason_code: 'RESERVE_SIMULATION_STALE',
              hint: `Last simulation was ${Math.round(simAge / (24 * 60 * 60 * 1000))} days ago (max 7). Run a new simulation.`,
              simulation_run_id: simRunId,
              simulation_created_at: simRun.created_at,
              max_age_days: 7,
            }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
      
      {
        // Check 1: Current liability snapshot vs reserve threshold
        const { data: liabilitySnapshot } = await supabaseAdmin.rpc('get_liability_snapshot', {})
        if (liabilitySnapshot) {
          const netBuffer = (liabilitySnapshot as { net_buffer?: number }).net_buffer ?? 0
          const minReserve = config.min_reserve_after_approval ?? 5000
          
          if (netBuffer - submittedAmount < minReserve) {
            return new Response(
              JSON.stringify({
                error: 'Payout blocked: Reserve threshold breach risk',
                net_buffer: netBuffer,
                payout_amount: submittedAmount,
                remaining_after: netBuffer - submittedAmount,
                min_reserve_required: minReserve,
                hint: 'Approving this payout would drop reserve below minimum. Increase reserve or disable gate in system_settings.',
              }),
              { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
        }
        
        // Check 2: If latest simulation shows high loss probability, warn
        if (config.last_simulation_run_id && config.block_if_simulated_loss_prob_above) {
          const { data: simRun } = await supabaseAdmin
            .from('simulation_runs')
            .select('probability_of_loss, reserve_breach_probability')
            .eq('id', config.last_simulation_run_id)
            .single()
          
          if (simRun) {
            const lossProb = Number(simRun.probability_of_loss)
            const threshold = config.block_if_simulated_loss_prob_above
            if (lossProb > threshold) {
              return new Response(
                JSON.stringify({
                  error: 'Payout blocked: Simulated loss probability exceeds threshold',
                  simulated_loss_prob: lossProb,
                  threshold,
                  simulation_run_id: config.last_simulation_run_id,
                  hint: 'Latest Monte Carlo simulation shows elevated risk. Review simulation results or adjust threshold in system_settings.',
                }),
                { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              )
            }
          }
        }
      }
    }

    // =============================================
    // EXECUTE PAYOUT STATE CHANGE
    // =============================================

    // Effective values
    let effectiveNewStatus = newStatus
    let effectivePaymentReference: string | null = null
    let effectivePaidAt: string | null = null
    let effectiveAmount = submittedAmount
    let wasIdempotentRpc = false
    let paymentId: string | null = null

    // For initiate_payment, use the atomic RPC
    if (body.action === 'initiate_payment') {
      const { data: initiateResult, error: initiateError } = await supabaseAdmin.rpc('initiate_payout_payment', {
        _payout_id: body.payout_id,
        _provider: body.provider,
        _amount: submittedAmount,
        _initiated_by: userId
      })
      
      if (initiateError) {
        throw new Error(`Failed to initiate payment: ${initiateError.message}`)
      }
      
      // deno-lint-ignore no-explicit-any
      const result = initiateResult as any
      if (!result?.success) {
        return new Response(
          JSON.stringify({ error: result?.error || 'Failed to initiate payment', details: result }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      effectiveNewStatus = 'payment_initiated'
      paymentId = result.payment_id
      effectiveAmount = result.amount || submittedAmount
      wasIdempotentRpc = false
      
    } else if (body.action === 'approve') {
      // C5 FIX: Use atomic RPC for approval (payout + account in one tx)
      const { data: approveResult, error: approveError } = await supabaseAdmin.rpc('approve_payout_atomic', {
        _payout_id: body.payout_id,
        _approved_by: userId,
        _review_notes: body.reason || null,
        _calculated_eligible_amount: calculatedEligibleAmount,
        _submitted_amount: submittedAmount,
        _fraud_review_id: fraudReviewId || null,
      })

      if (approveError) {
        throw new Error(`Failed to approve payout: ${approveError.message}`)
      }

      // deno-lint-ignore no-explicit-any
      const approveData = approveResult as any
      if (!approveData?.success) {
        return new Response(
          JSON.stringify({ error: approveData?.error || 'Failed to approve payout', details: approveData }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      effectiveNewStatus = 'approved'

    } else if (body.action === 'reject') {
      // Use atomic RPC for rejection
      const { data: rejectResult, error: rejectError } = await supabaseAdmin.rpc('reject_payout_atomic', {
        _payout_id: body.payout_id,
        _rejected_by: userId,
        _reason: body.reason || 'Rejected',
      })

      if (rejectError) {
        throw new Error(`Failed to reject payout: ${rejectError.message}`)
      }

      // deno-lint-ignore no-explicit-any
      const rejectData = rejectResult as any
      if (!rejectData?.success) {
        return new Response(
          JSON.stringify({ error: rejectData?.error || 'Failed to reject payout', details: rejectData }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      effectiveNewStatus = 'rejected'

    } else {
      // For request_more_info: simple update (no account status change needed)
      const updateData: Record<string, unknown> = {
        status: newStatus,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      }

      if (body.reason) {
        updateData.review_notes = body.reason
      }

      const { error: updateError } = await supabaseAdmin
        .from('payouts')
        .update(updateData)
        .eq('id', body.payout_id)

      if (updateError) {
        throw new Error(`Failed to update payout: ${updateError.message}`)
      }

      // request_more_info updates account to payout_under_review
      if (body.action === 'request_more_info') {
        await supabaseAdmin
          .from('accounts')
          .update({ status: 'payout_under_review' })
          .eq('id', payout.account_id)
      }
    }

    // Determine audit action and event type
    const auditActions: Record<PayoutAction, string> = {
      approve: 'payout_approved',
      reject: 'payout_rejected',
      request_more_info: 'status_changed',
      initiate_payment: 'status_changed',
    }

    const eventTypes: Record<PayoutAction, string> = {
      approve: 'payout_approved',
      reject: 'payout_rejected',
      request_more_info: 'payout_under_review',
      initiate_payment: 'status_changed',
    }

    // Create audit log with full verification details (use effective values)
    const auditResult = await insertAuditLog(supabaseAdmin, {
      user_id: userId,
      account_id: payout.account_id,
      action: auditActions[body.action],
      request_id: requestId,
      idempotency_key: effectiveIdempotencyKey, // Same key for all deduplication
      reason: body.reason || `Payout ${body.action}`,
      details: {
        payout_id: body.payout_id,
        previous_status: previousStatus,
        new_status: effectiveNewStatus,
        action_type: body.action,
        submitted_amount: submittedAmount,
        effective_amount: effectiveAmount,
        effective_amount_cents: amountToCents(effectiveAmount), // For audit trail
        calculated_eligible_amount: calculatedEligibleAmount,
        eligibility_check: eligibility,
        correlations_check: correlations?.has_correlations ? {
          found: true,
          count: correlations.correlation_count
        } : { found: false },
        fraud_review_id: fraudReviewId,
        skip_fraud_check: body.skip_fraud_check || false,
        payment_reference: effectivePaymentReference,
        paid_at: effectivePaidAt,
        was_idempotent_rpc: wasIdempotentRpc,
        actor_role: 'admin',
      },
    })
    
    // Log dedupe result for ops visibility
    console.log(`payout audit dedupe: action=${body.action}, inserted=${auditResult.inserted}, key=${effectiveIdempotencyKey}`)

    // Create trader-visible event (use effective values)
    const formattedAmount = effectiveAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const eventExplanations: Record<PayoutAction, string> = {
      approve: `Your payout request for $${formattedAmount} has been approved.`,
      reject: `Your payout request has been declined. Reason: ${body.reason}`,
      request_more_info: `Additional information has been requested for your payout. Reason: ${body.reason}`,
      initiate_payment: `Your payout of $${formattedAmount} is being processed via ${body.provider}.`,
    }

    // Generate event idempotency key with explicit namespace IN the hash input
    // CRITICAL: Use SAME normalized value for hash AND event_type column
    // Store raw in event_data if needed for debugging
    const rawEventType = eventTypes[body.action]
    const eventTypeNorm = normalizeEventType(rawEventType)
    
    const amountCents = amountToCents(effectiveAmount) // effectiveAmount comes from DB on mark_paid
    const eventKeyInput = `acctevt:${eventTypeNorm}:${payout.account_id}:${body.payout_id}:${amountCents}`
    const eventIdempotencyKey = `acctevt.${eventTypeNorm}:` + await generateDeterministicKey(eventKeyInput)
    
    // Drift guard: warn if normalization changed the value (enum mismatch risk)
    // Format: machine-grepable, includes all relevant context for correlation
    // Only logs if there's actual drift
    if (rawEventType !== eventTypeNorm) {
      console.warn(`DRIFT_EVENT_TYPE action=${body.action} raw=${rawEventType} norm=${eventTypeNorm} event_type=${eventTypeNorm} audit_key=${effectiveIdempotencyKey} event_key=${eventIdempotencyKey} request_id=${requestId}`)
    }
    
    const eventResult = await insertAccountEvent(supabaseAdmin, {
      account_id: payout.account_id,
      event_type: eventTypeNorm as typeof rawEventType, // Use normalized for consistency
      request_id: requestId,
      idempotency_key: eventIdempotencyKey,
      event_data: {
        payout_id: body.payout_id,
        previous_status: previousStatus,
        new_status: effectiveNewStatus,
        amount: effectiveAmount,
        amount_cents: amountCents,
        explanation: eventExplanations[body.action],
        payment_reference: effectivePaymentReference,
        paid_at: effectivePaidAt,
        actor_role: 'admin',
        raw_event_type: rawEventType, // Original for debugging
      },
    })
    
    // Log dedupe result for ops visibility (both keys)
    console.log(`payout dedupe: audit_inserted=${auditResult.inserted} audit_key=${effectiveIdempotencyKey}, event_inserted=${eventResult.inserted} event_key=${eventIdempotencyKey}`)

    // Determine if this was a duplicate request
    const wasDuplicate = (!auditResult.inserted && !eventResult.inserted) || wasIdempotentRpc

    return new Response(
      JSON.stringify({
        success: true,
        payout_id: body.payout_id,
        account_id: payout.account_id,
        previous_status: previousStatus,
        new_status: effectiveNewStatus,
        action: body.action,
        request_id: requestId,
        audit_idempotency_key: effectiveIdempotencyKey,
        event_idempotency_key: eventIdempotencyKey,
        event_type: eventTypeNorm,
        deduplicated: wasDuplicate,
        audit_deduplicated: !auditResult.inserted,
        event_deduplicated: !eventResult.inserted,
        // initiate_payment specific fields
        ...(body.action === 'initiate_payment' ? {
          payment_id: paymentId,
          provider: body.provider,
        } : {}),
        // P0 verification results
        verification: body.action === 'approve' ? {
          submitted_amount: submittedAmount,
          calculated_eligible_amount: calculatedEligibleAmount,
          amount_verified: true,
          eligibility_verified: true,
          correlations_checked: true,
          correlations_found: correlations?.has_correlations || false,
          fraud_review_created: !!fraudReviewId,
          skip_fraud_check: body.skip_fraud_check || false,
          econ_gate_status: econGateResult?.status ?? 'not_checked',
          econ_gate_warnings: econGateResult?.status === 'warn' ? econGateResult.reasons : undefined,
        } : undefined,
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
