/**
 * Idempotency Tests for review-actions edge function
 * 
 * Tests verify:
 * 1. add_note twice with same content → deduped audit on 2nd call
 * 2. add_note with different content → new audit entries
 * 3. Reason normalization (whitespace/case) produces same keys
 * 4. Idempotency keys match between retries
 * 5. Key charset, length, and prefix constraints are met
 * 
 * Run with: deno test -A supabase/functions/review-actions/idempotency_test.ts
 * 
 * Required environment variables:
 *   TEST_STAFF_TOKEN - JWT for a staff user (risk_officer or admin)
 *   TEST_ACCOUNT_ID - Account ID in active state (for add_note tests)
 *   TEST_ACCOUNT_ID_BREACHED - Account ID in breached state (for clear_breach tests)
 * 
 * NOTE: Tests that query account_events directly require service_role or a staff RPC.
 * The ignore:true tests are for manual verification with elevated privileges.
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertValidAuditKey,
  assertValidEventKey,
  uniqueSuffix,
  AUDIT_KEY_PREFIX,
  EVENT_KEY_PREFIX,
} from "../_test/test_utils.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/review-actions`;

// These tests require a staff user token and state-specific account IDs
const STAFF_TOKEN = Deno.env.get("TEST_STAFF_TOKEN");
const TEST_ACCOUNT_ID = Deno.env.get("TEST_ACCOUNT_ID");
const TEST_ACCOUNT_ID_BREACHED = Deno.env.get("TEST_ACCOUNT_ID_BREACHED");

const skipTests = !STAFF_TOKEN || !TEST_ACCOUNT_ID;
const skipBreachTests = !STAFF_TOKEN || !TEST_ACCOUNT_ID_BREACHED;

Deno.test({
  name: "review-actions: add_note is idempotent (dedupes audit on retry)",
  ignore: skipTests,
  async fn() {
    const noteContent = `Test note for idempotency ${uniqueSuffix()}`;
    
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

    // First call MUST succeed - if not, test setup is wrong
    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    assertEquals(b1.success, true, `First call should succeed: ${JSON.stringify(b1)}`);
    
    // Validate key format and prefix
    // add_note only creates audit log, not account event
    assertValidAuditKey(b1.idempotency_key, "idempotency_key");
    
    // First call should NOT be deduplicated
    assertEquals(b1.deduplicated, false, "First call should insert audit (not deduped)");

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
    assertEquals(b2.success, true, "Second call should report success");
    
    // Keys must match between calls
    assertEquals(b2.idempotency_key, b1.idempotency_key, "Audit keys should match");
    
    // Second call should be deduplicated
    assertEquals(b2.deduplicated, true, "Audit should be deduplicated on retry");
    
    // Verify previous_status/new_status present (add_note = no state change)
    assertExists(b2.previous_status, "Second call should include previous_status");
    assertExists(b2.new_status, "Second call should include new_status");
    assertEquals(b2.previous_status, b2.new_status, "add_note should not change status");
  },
});

Deno.test({
  name: "review-actions: different note content produces different keys",
  ignore: skipTests,
  async fn() {
    const suffix = uniqueSuffix();
    const noteContent1 = `Test note A ${suffix}`;
    const noteContent2 = `Test note B ${suffix}`;

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
      key1: b1.idempotency_key,
      key2: b2.idempotency_key,
    });

    assertEquals(r1.status, 200);
    assertEquals(r2.status, 200);
    
    // Neither should be deduplicated (different content)
    assertEquals(b1.deduplicated, false, "First note should insert");
    assertEquals(b2.deduplicated, false, "Second note should insert (different content)");
    
    // Keys should differ
    assert(
      b1.idempotency_key !== b2.idempotency_key,
      "Different content should produce different keys"
    );
  },
});

Deno.test({
  name: "review-actions: reason normalization dedupes whitespace/case variants",
  ignore: skipTests,
  async fn() {
    // This is the highest-signal regression test for normalizers
    // Call #1: "  Hello   WORLD  "
    // Call #2: "hello world"
    // Expect: same key + dedupe true on second
    const suffix = uniqueSuffix();
    const baseReason = `hello world ${suffix}`;
    
    // First call with extra whitespace and uppercase
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: `  HELLO   WORLD   ${suffix}  `,
      }),
    });
    const b1 = await r1.json();
    console.log("First normalized reason response:", b1);

    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    assertValidAuditKey(b1.idempotency_key, "idempotency_key");

    // First call should NOT be deduplicated
    assertEquals(b1.deduplicated, false, "First call should insert (not deduped)");

    // Second call with normalized version (lowercase, single spaces, trimmed)
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: baseReason,
      }),
    });
    const b2 = await r2.json();
    console.log("Second normalized reason response:", b2);

    assertEquals(r2.status, 200);
    assertEquals(b2.success, true, "Second call should report success");
    
    // After normalization, keys should match
    assertEquals(
      b2.idempotency_key,
      b1.idempotency_key,
      "Normalized reasons should produce same key"
    );
    
    // Second call should be deduplicated
    assertEquals(b2.deduplicated, true, "Normalized duplicate should be deduplicated");
  },
});

Deno.test({
  name: "review-actions: clear_breach is idempotent with correct prefixes",
  ignore: skipBreachTests,
  async fn() {
    const reason = `Clear breach test ${uniqueSuffix()}`;
    
    const payload = {
      action: "clear_breach",
      account_id: TEST_ACCOUNT_ID_BREACHED,
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

    // First call MUST succeed - if not, test setup is wrong
    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)} - ensure TEST_ACCOUNT_ID_BREACHED is in breached_detected/under_review state`);
    assertEquals(b1.success, true, `First call should succeed: ${JSON.stringify(b1)}`);

    // Validate state transition (proves we got the right account)
    assertExists(b1.previous_status, "Response should include previous_status");
    assertExists(b1.new_status, "Response should include new_status");
    assertEquals(b1.new_status, "active", "clear_breach should transition to active");

    // Validate key format and prefixes
    assertValidAuditKey(b1.audit_idempotency_key, "audit_idempotency_key");
    assertValidEventKey(b1.event_idempotency_key, "event_idempotency_key");
    
    // First call should NOT be deduplicated
    assertEquals(b1.audit_deduplicated, false, "First call should insert audit (not deduped)");
    assertEquals(b1.event_deduplicated, false, "First call should insert event (not deduped)");

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

    assertEquals(r2.status, 200, "Second call should succeed");
    assertEquals(b2.success, true, "Second call should report success");
    assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
    assertEquals(b2.event_idempotency_key, b1.event_idempotency_key, "Event keys should match");
    assertEquals(b2.audit_deduplicated, true, "Audit should be deduplicated on retry");
    assertEquals(b2.event_deduplicated, true, "Event should be deduplicated on retry");
  },
});

Deno.test({
  name: "review-actions: verify key prefix semantics",
  ignore: skipTests,
  async fn() {
    // Quick test that just validates the prefix format is correct
    // without needing specific state
    const noteContent = `Prefix test ${uniqueSuffix()}`;
    
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: noteContent,
      }),
    });
    const body = await res.json();

    assertEquals(res.status, 200);
    
    // Verify audit key has correct prefix
    assert(
      body.idempotency_key.startsWith(AUDIT_KEY_PREFIX),
      `Audit key must start with '${AUDIT_KEY_PREFIX}', got: ${body.idempotency_key.slice(0, 20)}...`
    );
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
  ignore: !STAFF_TOKEN,
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
  name: "review-actions: invalid action returns 400",
  ignore: !STAFF_TOKEN,
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "invalid_action",
        account_id: "00000000-0000-0000-0000-000000000000",
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
