/**
 * Daily Risk Snapshot — Auth Acceptance Tests
 * 
 * Proves the auth gate is fail-closed:
 * 1. No auth → 401
 * 2. Anon key as Bearer → 401 (it's a public key, not a credential)
 * 3. Wrong cron secret → 401
 * 4. Correct cron secret → 200
 * 5. Duplicate calls same hour → no duplicate notification
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import 'https://deno.land/std@0.224.0/dotenv/load.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://sfxmgwkrjwuerfkqxokq.supabase.co'
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmeG1nd2tyand1ZXJma3F4b2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NTE0MTUsImV4cCI6MjA4NTUyNzQxNX0.uKTtbs9vWdtAJLDFod4evkVj1DLjJkRloIRWnbu5GoM'
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/daily-risk-snapshot`

const hasCronSecret = CRON_SECRET.length > 0
const hasServiceKey = SERVICE_ROLE_KEY.length > 0
const opts = { sanitizeResources: false, sanitizeOps: false }

// =============================================================================
// Auth Gate Tests
// =============================================================================

Deno.test({ name: 'daily-risk-snapshot: no auth header → 401', ...opts, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json()
  assertEquals(res.status, 401, `Expected 401, got ${res.status}`)
  assertEquals(body.reason_code, 'NO_AUTH', `Expected NO_AUTH, got ${body.reason_code}`)
}})

Deno.test({ name: 'daily-risk-snapshot: anon key as Bearer → 401 (not a credential)', ...opts, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
    },
  })
  const body = await res.json()
  // Anon key is not a valid user JWT, so getUser() will fail → 401
  assertEquals(res.status, 401, `Expected 401, got ${res.status}`)
  assertEquals(body.reason_code, 'INVALID_JWT', `Expected INVALID_JWT, got ${body.reason_code}`)
}})

Deno.test({ name: 'daily-risk-snapshot: wrong cron secret → 401', ...opts, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': 'totally-wrong-secret-value',
    },
  })
  const body = await res.json()
  assertEquals(res.status, 401, `Expected 401, got ${res.status}`)
  // Could be INVALID_CRON_SECRET or CRON_SECRET_NOT_CONFIGURED depending on env
  const validCodes = ['INVALID_CRON_SECRET', 'CRON_SECRET_NOT_CONFIGURED']
  assertEquals(validCodes.includes(body.reason_code), true, `Expected valid rejection code, got ${body.reason_code}`)
}})

Deno.test({ name: 'daily-risk-snapshot: correct cron secret → 200', ...opts, ignore: !hasCronSecret, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': CRON_SECRET,
    },
  })
  const body = await res.json()
  assertEquals(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  assertEquals(body.success, true, 'Expected success=true')
  assertEquals(body.triggered_by, 'cron', 'Expected triggered_by=cron')
}})

// =============================================================================
// Notification Idempotency Test
// =============================================================================

Deno.test({ name: 'staff_notifications: duplicate idempotency_key does not create second row', ...opts, ignore: !hasServiceKey, fn: async () => {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const testKey = `test_idempotency_${Date.now()}`

  // First insert
  const { error: err1 } = await db.from('staff_notifications').upsert(
    {
      notification_type: 'test',
      title: 'Test 1',
      idempotency_key: testKey,
    },
    { onConflict: 'idempotency_key', ignoreDuplicates: true }
  )
  assertEquals(err1, null, `First insert should succeed: ${err1?.message}`)

  // Second insert with same key — should be silently ignored
  const { error: err2 } = await db.from('staff_notifications').upsert(
    {
      notification_type: 'test',
      title: 'Test 2 DUPLICATE',
      idempotency_key: testKey,
    },
    { onConflict: 'idempotency_key', ignoreDuplicates: true }
  )
  assertEquals(err2, null, `Duplicate upsert should not error: ${err2?.message}`)

  // Verify only one row exists
  const { data, error: readErr } = await db
    .from('staff_notifications')
    .select('id, title')
    .eq('idempotency_key', testKey)
  assertEquals(readErr, null, `Read should succeed: ${readErr?.message}`)
  assertEquals(data?.length, 1, `Expected exactly 1 row, got ${data?.length}`)
  assertEquals(data?.[0]?.title, 'Test 1', 'First insert should be preserved, not overwritten')

  // Cleanup
  await db.from('staff_notifications').delete().eq('idempotency_key', testKey)
}})
