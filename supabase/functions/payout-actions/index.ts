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
  mark_paid: {
    from: ['approved'],
    to: 'paid'
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

    if (body.action === 'mark_paid' && !body.payment_reference) {
      return new Response(
        JSON.stringify({ error: 'Payment reference is required for mark_paid' }),
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
      // Include 'audit' namespace IN the hash input to prevent cross-table reuse
      // Use cents for amount to avoid formatting inconsistencies (100 vs 100.0 vs 100.00)
      const amountCents = amountToCents(submittedAmount)
      let keyInput: string
      switch (body.action) {
        case 'mark_paid': {
          const normalizedRef = normalizePaymentRef(body.payment_reference ?? '')
          // Namespace included in hash input
          keyInput = `audit:mark_paid:${body.payout_id}:${normalizedRef}:${amountCents}`
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
      // Prefix stored key with 'audit.' for explicit table targeting
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
    if (body.action === 'approve' || body.action === 'mark_paid') {
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
    // EXECUTE PAYOUT STATE CHANGE
    // =============================================

    // Effective values - will be set from RPC result for mark_paid
    let effectiveNewStatus = newStatus
    let effectivePaymentReference = body.payment_reference || null
    let effectivePaidAt: string | null = null
    let effectiveAmount = submittedAmount
    let wasIdempotentRpc = false

    // For mark_paid, use the atomic RPC that handles payout + cycle reset in one transaction
    if (body.action === 'mark_paid') {
      const { data: markPaidResult, error: markPaidError } = await supabaseAdmin.rpc('mark_payout_paid', {
        _payout_id: body.payout_id,
        _payment_reference: body.payment_reference,
        _reviewed_by: userId
      })
      
      if (markPaidError) {
        throw new Error(`Failed to mark payout paid: ${markPaidError.message}`)
      }
      
      // deno-lint-ignore no-explicit-any
      const result = markPaidResult as any
      if (!result?.success) {
        return new Response(
          JSON.stringify({ error: result?.error || 'Failed to mark payout paid' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      // Extract effective values from RPC result (DB truth)
      effectiveNewStatus = result.payout?.status || 'paid'
      effectivePaymentReference = result.payout?.payment_reference || body.payment_reference
      effectivePaidAt = result.payout?.paid_at || new Date().toISOString()
      effectiveAmount = result.payout?.amount || submittedAmount
      wasIdempotentRpc = result.idempotent || false
      
    } else {
      // For non-mark_paid actions, use regular update flow
      const updateData: Record<string, unknown> = {
        status: newStatus,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      }

      if (body.reason) {
        updateData.review_notes = body.reason
      }

      // Store server-calculated amount for audit trail
      if (calculatedEligibleAmount !== null) {
        updateData.calculated_eligible_amount = calculatedEligibleAmount
        updateData.submitted_amount = submittedAmount
      }

      if (fraudReviewId) {
        updateData.fraud_review_id = fraudReviewId
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
    // Handle null payment reference cleanly in message
    const refText = effectivePaymentReference ? ` Reference: ${effectivePaymentReference}` : ''
    const eventExplanations: Record<PayoutAction, string> = {
      approve: `Your payout request for $${formattedAmount} has been approved.`,
      reject: `Your payout request has been declined. Reason: ${body.reason}`,
      request_more_info: `Additional information has been requested for your payout. Reason: ${body.reason}`,
      mark_paid: `Your payout of $${formattedAmount} has been sent.${refText}`,
    }

    // Generate event idempotency key with explicit namespace IN the hash input
    // This ensures collision protection even if someone strips prefixes
    // CRITICAL: Use DB-sourced effectiveAmount (not client amount) for mark_paid idempotency
    const rawEventType = eventTypes[body.action]
    const eventTypeNorm = normalizeEventType(rawEventType)
    const amountCents = amountToCents(effectiveAmount) // effectiveAmount comes from DB on mark_paid
    const eventKeyInput = `acctevt:${eventTypeNorm}:${payout.account_id}:${body.payout_id}:${amountCents}`
    const eventIdempotencyKey = `acctevt.${eventTypeNorm}:` + await generateDeterministicKey(eventKeyInput)
    
    const eventResult = await insertAccountEvent(supabaseAdmin, {
      account_id: payout.account_id,
      event_type: rawEventType, // DB enum expects exact value (already snake_case)
      request_id: requestId,
      idempotency_key: eventIdempotencyKey,
      event_data: {
        payout_id: body.payout_id,
        previous_status: previousStatus,
        new_status: effectiveNewStatus,
        amount: effectiveAmount,
        amount_cents: amountCents, // For audit trail
        explanation: eventExplanations[body.action],
        payment_reference: effectivePaymentReference,
        paid_at: effectivePaidAt,
        actor_role: 'admin',
        event_type_normalized: eventTypeNorm, // For audit trail
      },
    })
    
    // Log dedupe result for ops visibility
    console.log(`payout event dedupe: action=${body.action}, inserted=${eventResult.inserted}, key=${eventIdempotencyKey}`)

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
        idempotency_key: effectiveIdempotencyKey, // Return effective key for client logging
        deduplicated: wasDuplicate, // Clear signal: was this a retry that got deduplicated?
        // mark_paid specific fields
        ...(body.action === 'mark_paid' ? {
          paid_at: effectivePaidAt,
          payment_reference: effectivePaymentReference,
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
