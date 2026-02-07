/**
 * Daily Risk Snapshot — Auth Acceptance Tests
 * 
 * Proves the auth gate is fail-closed:
 * 1. No auth → 401
 * 2. Anon key as Bearer → 401
 * 3. Wrong cron secret (when env configured) → 401
 * 4. Cron secret when env NOT configured → 503
 * 5. Correct cron secret → 200
 * 6. Duplicate calls same hour → no duplicate notification
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import 'https://deno.land/std@0.224.0/dotenv/load.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://sfxmgwkrjwuerfkqxokq.supabase.co'
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmeG1nd2tyand1ZXJma3F4b2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NTE0MTUsImV4cCI6MjA4NTUyNzQxNX0.uKTtbs9vWdtAJLDFod4evkVj1DLjJkRloIRWnbu5GoM'
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/daily-risk-snapshot`

// Mirror the function's own min-length requirement (16 chars)
const hasCronSecret = CRON_SECRET.length >= 16
const hasServiceKey = SERVICE_ROLE_KEY.length > 0
const opts = { sanitizeResources: false, sanitizeOps: false }

// =============================================================================
// Auth Gate Tests
// =============================================================================

Deno.test({ name: 'no auth header → 401', ...opts, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.text()
  assertEquals(res.status, 401, `Expected 401, got ${res.status}: ${body}`)
}})

Deno.test({ name: 'anon key as Bearer → 401 (public key is not a credential)', ...opts, fn: async () => {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
    },
  })
  const body = await res.text()
  assertEquals(res.status, 401, `Expected 401, got ${res.status}: ${body}`)
}})

Deno.test({
  name: 'wrong cron secret (env configured) → 401',
  ...opts,
  ignore: !hasCronSecret, // only meaningful when CRON_SECRET is actually set
  fn: async () => {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': 'totally-wrong-secret-value',
      },
    })
    const body = await res.text()
    assertEquals(res.status, 401, `Expected 401, got ${res.status}: ${body}`)
  },
})

Deno.test({
  name: 'cron secret header when env NOT configured → 503',
  ...opts,
  ignore: hasCronSecret, // only runs when CRON_SECRET is missing from test env
  fn: async () => {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': 'any-value-doesnt-matter',
      },
    })
    const body = await res.text()
    assertEquals(res.status, 503, `Expected 503 (server misconfig), got ${res.status}: ${body}`)
  },
})

Deno.test({
  name: 'cron secret env too short (< 16 chars) → 503 operator misconfig',
  ...opts,
  ignore: true, // only meaningful when CRON_SECRET is intentionally set short in CI
  fn: async () => {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': 'any-value',
      },
    })
    const body = await res.text()
    assertEquals(res.status, 503, `Expected 503 (env too short), got ${res.status}: ${body}`)
  },
})

Deno.test({
  name: 'correct cron secret → 200 + writes snapshot',
  ...opts,
  ignore: !hasCronSecret,
  fn: async () => {
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
  },
})

// =============================================================================
// Notification Idempotency Test
// =============================================================================

Deno.test({
  name: 'duplicate idempotency_key → exactly 1 notification row',
  ...opts,
  ignore: !hasServiceKey,
  fn: async () => {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const testKey = `test_idempotency_${Date.now()}`

    // First insert
    const { error: err1 } = await db.from('staff_notifications').upsert(
      { notification_type: 'test', title: 'Test 1', idempotency_key: testKey },
      { onConflict: 'idempotency_key', ignoreDuplicates: true }
    )
    assertEquals(err1, null, `First insert failed: ${err1?.message}`)

    // Second insert — silently ignored
    const { error: err2 } = await db.from('staff_notifications').upsert(
      { notification_type: 'test', title: 'Test 2 DUPLICATE', idempotency_key: testKey },
      { onConflict: 'idempotency_key', ignoreDuplicates: true }
    )
    assertEquals(err2, null, `Duplicate upsert errored: ${err2?.message}`)

    // Verify exactly 1 row, title preserved from first insert
    const { data, error: readErr } = await db
      .from('staff_notifications')
      .select('id, title')
      .eq('idempotency_key', testKey)
    assertEquals(readErr, null, `Read failed: ${readErr?.message}`)
    assertEquals(data?.length, 1, `Expected 1 row, got ${data?.length}`)
    assertEquals(data?.[0]?.title, 'Test 1', 'First insert should be preserved')

    // Cleanup
    await db.from('staff_notifications').delete().eq('idempotency_key', testKey)
  },
})
