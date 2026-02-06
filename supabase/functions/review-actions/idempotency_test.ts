/**
 * Idempotency Tests for review-actions edge function
 * 
 * Tests verify:
 * 1. add_note twice with same content → deduped audit on 2nd call
 * 2. add_note with different content → new audit entries
 * 3. Reason normalization (whitespace/case) produces same keys
 * 4. Idempotency keys match between retries
 * 5. Key charset and length constraints are met
 * 
 * Run with: deno test --allow-net --allow-env supabase/functions/review-actions/idempotency_test.ts
 * 
 * NOTE: Tests that query account_events directly require service_role or a staff RPC.
 * The ignore:true tests are for manual verification with elevated privileges.
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/review-actions`;

// These tests require a staff user token and test data
const STAFF_TOKEN = Deno.env.get("TEST_STAFF_TOKEN");
const TEST_ACCOUNT_ID = Deno.env.get("TEST_ACCOUNT_ID");

const skipTests = !STAFF_TOKEN || !TEST_ACCOUNT_ID;

// Idempotency key format: namespace.hash or namespace.type:hash
// Charset: alphanumeric, colon, underscore, hyphen, dot
const KEY_REGEX = /^[a-zA-Z0-9:_\-.]+$/;
const KEY_MIN_LENGTH = 10;
const KEY_MAX_LENGTH = 200;

function assertValidIdempotencyKey(key: string, label: string) {
  assertExists(key, `${label} should exist`);
  assert(KEY_REGEX.test(key), `${label} should match charset constraint: ${key}`);
  assert(key.length >= KEY_MIN_LENGTH, `${label} should be >= ${KEY_MIN_LENGTH} chars: ${key.length}`);
  assert(key.length <= KEY_MAX_LENGTH, `${label} should be <= ${KEY_MAX_LENGTH} chars: ${key.length}`);
}

Deno.test({
  name: "review-actions: add_note is idempotent (dedupes audit on retry)",
  ignore: skipTests,
  async fn() {
    const noteContent = `Test note for idempotency ${Date.now()}`;
    
    const payload = {
      action: "add_note",
      account_id: TEST_ACCOUNT_ID,
      reason: noteContent,
    };

    // First call
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b1 = await r1.json();
    console.log("First add_note response:", b1);

    assertEquals(r1.status, 200, "First call should succeed");
    assertEquals(b1.success, true, "First call should succeed");
    
    // Validate key format
    assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");
    
    // First call should insert
    assertEquals(b1.audit_deduplicated, false, "First call should insert audit");

    // Second call with identical content
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b2 = await r2.json();
    console.log("Second add_note response:", b2);

    assertEquals(r2.status, 200, "Second call should succeed");
    assertEquals(b2.success, true, "Second call should succeed");
    
    // Keys must match between calls
    assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
    
    // Second call should be deduplicated
    assertEquals(b2.audit_deduplicated, true, "Audit should be deduplicated on retry");
  },
});

Deno.test({
  name: "review-actions: different note content produces different keys",
  ignore: skipTests,
  async fn() {
    const timestamp = Date.now();
    const noteContent1 = `Test note A ${timestamp}`;
    const noteContent2 = `Test note B ${timestamp}`;

    // First call
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: noteContent1,
      }),
    });
    const b1 = await r1.json();

    // Second call with different content
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: noteContent2,
      }),
    });
    const b2 = await r2.json();

    console.log("Different notes test:", {
      key1: b1.audit_idempotency_key,
      key2: b2.audit_idempotency_key,
    });

    assertEquals(r1.status, 200);
    assertEquals(r2.status, 200);
    
    // Neither should be deduplicated (different content)
    assertEquals(b1.audit_deduplicated, false, "First note should insert");
    assertEquals(b2.audit_deduplicated, false, "Second note should insert (different content)");
    
    // Keys should differ
    assert(
      b1.audit_idempotency_key !== b2.audit_idempotency_key,
      "Different content should produce different keys"
    );
  },
});

Deno.test({
  name: "review-actions: reason normalization dedupes whitespace/case variants",
  ignore: skipTests,
  async fn() {
    const baseReason = `normalized reason test ${Date.now()}`;
    
    // First call with lowercase
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: baseReason.toLowerCase(),
      }),
    });
    const b1 = await r1.json();
    console.log("First normalized reason response:", b1);

    assertEquals(r1.status, 200);
    assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");

    // Second call with extra whitespace and uppercase
    // After normalization (trim + collapse whitespace + lowercase), should match
    const reasonWithNoise = `  ${baseReason.toUpperCase()}   `;
    
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: reasonWithNoise,
      }),
    });
    const b2 = await r2.json();
    console.log("Second normalized reason response:", b2);

    assertEquals(r2.status, 200);
    
    // After normalization, keys should match
    assertEquals(
      b2.audit_idempotency_key,
      b1.audit_idempotency_key,
      "Normalized reasons should produce same key"
    );
    
    // Second call should be deduplicated
    assertEquals(b2.audit_deduplicated, true, "Normalized duplicate should be deduplicated");
  },
});

Deno.test({
  name: "review-actions: clear_breach is idempotent",
  ignore: skipTests,
  async fn() {
    const reason = `Clear breach test ${Date.now()}`;
    
    const payload = {
      action: "clear_breach",
      account_id: TEST_ACCOUNT_ID,
      reason: reason,
    };

    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b1 = await r1.json();
    console.log("First clear_breach response:", b1);

    if (r1.status === 200 && b1.success) {
      assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");

      // Second call
      const r2 = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${STAFF_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      const b2 = await r2.json();
      console.log("Second clear_breach response:", b2);

      assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
      assertEquals(b2.audit_deduplicated, true, "Should be deduplicated on retry");
    } else if (r1.status === 400) {
      // Account not in breached state - that's fine
      console.log("Account not in clearable state:", b1.error);
    }
  },
});

Deno.test({
  name: "review-actions: verify event_type normalization consistency",
  // NOTE: Requires service_role or staff RPC to query account_events
  // Keep ignored for automated runs; use for manual verification
  ignore: true,
  async fn() {
    // This test would verify:
    // 1. Query account_events for a known account
    // 2. Check event_type column equals normalized value
    // 3. Check event_data.raw_event_type equals original mapping
    // 
    // Requires elevated privileges - run manually with service_role
    console.log("This test requires service_role access to query account_events");
  },
});

Deno.test({
  name: "review-actions: unauthorized request returns 401",
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth header
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: "00000000-0000-0000-0000-000000000000",
        reason: "test",
      }),
    });
    
    const body = await res.text();
    assertEquals(res.status, 401, `Expected 401, got ${res.status}: ${body}`);
  },
});

Deno.test({
  name: "review-actions: missing account_id returns 400",
  ignore: skipTests,
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        // Missing account_id
        reason: "test",
      }),
    });
    
    const body = await res.json();
    assertEquals(res.status, 400);
    assertExists(body.error);
  },
});

Deno.test({
  name: "review-actions: confirm_failure requires admin role",
  ignore: skipTests,
  async fn() {
    // If STAFF_TOKEN is a risk_officer (not admin), this should return 403
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "confirm_failure",
        account_id: TEST_ACCOUNT_ID,
        reason: "Test confirmation",
      }),
    });
    
    const body = await res.json();
    console.log("confirm_failure by staff:", res.status, body);
    
    // Either succeeds (if admin) or 403 (if risk_officer)
    assert(res.status === 200 || res.status === 403, `Expected 200 or 403, got ${res.status}`);
  },
});
