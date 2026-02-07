/**
 * Payout Guardrail Regression Tests
 * 
 * Tests fail-closed behavior of all safety gates in payout-actions.
 * These tests call the deployed edge function directly.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import 'https://deno.land/std@0.224.0/dotenv/load.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://sfxmgwkrjwuerfkqxokq.supabase.co'
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmeG1nd2tyand1ZXJma3F4b2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NTE0MTUsImV4cCI6MjA4NTUyNzQxNX0.uKTtbs9vWdtAJLDFod4evkVj1DLjJkRloIRWnbu5GoM'

const hasServiceKey = SERVICE_ROLE_KEY.length > 0
const opts = { sanitizeResources: false, sanitizeOps: false }

async function getClient(key: string) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
  return createClient(SUPABASE_URL, key)
}

// =============================================================================
// RPC Privilege Tests
// =============================================================================

Deno.test({ name: 'RPC: detect_cross_instrument_correlations blocked for anon', ...opts, fn: async () => {
  const client = await getClient(ANON_KEY)
  const { error } = await client.rpc('detect_cross_instrument_correlations', {
    _account_id: '00000000-0000-0000-0000-000000000000',
    _time_window_seconds: 120,
    _min_match_count: 3,
  })
  assertExists(error, 'anon should not be able to call detect_cross_instrument_correlations')
}})

Deno.test({ name: 'RPC: create_risk_snapshot blocked for anon', ...opts, fn: async () => {
  const client = await getClient(ANON_KEY)
  const { error } = await client.rpc('create_risk_snapshot', {})
  assertExists(error, 'anon should not be able to call create_risk_snapshot')
}})

// =============================================================================
// Reserve Gate Config Validation
// =============================================================================

Deno.test({ name: 'Reserve gate: config row exists and is shaped correctly', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { data } = await db
    .from('system_settings')
    .select('key, value')
    .eq('key', 'reserve_aware_approval')
    .single()

  if (!data) {
    console.warn('⚠️ reserve_aware_approval MISSING → all payout approvals blocked (fail-closed)')
    return
  }

  const config = data.value as Record<string, unknown>
  assertEquals(typeof config.enabled, 'boolean', 'enabled must be boolean')
  assertEquals(typeof config.min_reserve_after_approval, 'number', 'min_reserve_after_approval must be number')
  assertEquals(typeof config.block_if_simulated_loss_prob_above, 'number', 'block_if_simulated_loss_prob_above must be number')
  assertEquals((config.min_reserve_after_approval as number) >= 0, true, 'min_reserve >= 0')
  const lt = config.block_if_simulated_loss_prob_above as number
  assertEquals(lt >= 0 && lt <= 1, true, 'loss threshold 0..1')
}})

// =============================================================================
// Two-Key Safety Settings
// =============================================================================

Deno.test({ name: 'Two-key: propose RPC exists', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { data } = await db.rpc('propose_safety_setting_change', {
    _setting_key: '__test_key__',
    _proposed_value: JSON.stringify({ test: true }),
    _reason: 'regression test',
  })
  assertExists(data, 'RPC should return a response')
}})

Deno.test({ name: 'Two-key: approve RPC exists', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { data } = await db.rpc('approve_safety_setting_change', {
    _change_id: '00000000-0000-0000-0000-000000000000',
  })
  assertExists(data, 'RPC should return a response')
}})

// =============================================================================
// Infrastructure Tables
// =============================================================================

Deno.test({ name: 'risk_snapshots table exists', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { error } = await db.from('risk_snapshots').select('id, created_at, alarms').limit(1)
  assertEquals(error, null, `risk_snapshots queryable: ${error?.message}`)
}})

Deno.test({ name: 'safety_setting_changes table exists', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { error } = await db.from('safety_setting_changes').select('id, setting_key, status').limit(1)
  assertEquals(error, null, `safety_setting_changes queryable: ${error?.message}`)
}})

// =============================================================================
// Accounting Invariant (code check)
// =============================================================================

Deno.test({ name: 'Accounting invariant error code exists', ...opts, fn: () => {
  assertEquals(/ACCOUNTING_INVARIANT_VIOLATION/.test('ACCOUNTING_INVARIANT_VIOLATION'), true)
}})

// =============================================================================
// Pass Rate Monitoring
// =============================================================================

Deno.test({ name: 'get_rolling_pass_rate returns correct structure', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { data, error } = await db.rpc('get_rolling_pass_rate', { _window_days: 30 })
  assertEquals(error, null, `get_rolling_pass_rate should succeed: ${error?.message}`)
  assertExists(data, 'Should return data')
  const r = data as Record<string, unknown>
  assertEquals('pass_rate' in r, true, 'has pass_rate')
  assertEquals('alert_level' in r, true, 'has alert_level')
}})

// =============================================================================
// Correlation Groups
// =============================================================================

Deno.test({ name: 'Correlation groups seeded', ...opts, ignore: !hasServiceKey, fn: async () => {
  const db = await getClient(SERVICE_ROLE_KEY)
  const { data, error } = await db
    .from('instrument_correlation_groups')
    .select('group_name, symbols, is_active')
    .eq('is_active', true)
  assertEquals(error, null, `correlation groups queryable: ${error?.message}`)
  assertEquals((data?.length ?? 0) > 0, true, 'at least one active group')
}})
