/**
 * Idempotency Tests for payout-actions edge function
 * 
 * Tests verify:
 * 1. approve twice with identical inputs → deduped audit+event on 2nd call
 * 2. mark_paid twice with same inputs → deduped on 2nd call
 * 3. Idempotency keys match between retries
 * 4. Key charset and length constraints are met
 * 5. Normalization produces consistent keys across whitespace/case variants
 * 
 * Run with: deno test -A supabase/functions/payout-actions/idempotency_test.ts
 * 
 * Required environment variables:
 *   TEST_ADMIN_TOKEN - JWT for an admin user
 *   TEST_PAYOUT_ID_PENDING - Payout ID in pending/under_review state (for approve tests)
 *   TEST_PAYOUT_ID_APPROVED - Payout ID in approved state (for mark_paid tests)
 * 
 * NOTE: Tests that query account_events directly require service_role or a staff RPC.
 * The ignore:true tests are for manual verification with elevated privileges.
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/payout-actions`;

// These tests require an admin user token and state-specific payout IDs
const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN");
const TEST_PAYOUT_ID_PENDING = Deno.env.get("TEST_PAYOUT_ID_PENDING") || Deno.env.get("TEST_PAYOUT_ID");
const TEST_PAYOUT_ID_APPROVED = Deno.env.get("TEST_PAYOUT_ID_APPROVED");

const skipApproveTests = !ADMIN_TOKEN || !TEST_PAYOUT_ID_PENDING;
const skipMarkPaidTests = !ADMIN_TOKEN || !TEST_PAYOUT_ID_APPROVED;
const skipTests = !ADMIN_TOKEN || (!TEST_PAYOUT_ID_PENDING && !TEST_PAYOUT_ID_APPROVED);

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
  name: "payout-actions: approve is idempotent (dedupes audit+event on retry)",
  ignore: skipApproveTests,
  async fn() {
    const payload = {
      action: "approve",
      payout_id: TEST_PAYOUT_ID_PENDING,
    };

    // First call
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b1 = await r1.json();
    console.log("First approve response:", b1);

    // First call MUST succeed - if not, test setup is wrong
    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    assertEquals(b1.success, true, `First call should succeed: ${JSON.stringify(b1)}`);

    // Validate key format
    assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");
    assertValidIdempotencyKey(b1.event_idempotency_key, "event_idempotency_key");

    // First call should NOT be deduplicated
    assertEquals(b1.audit_deduplicated, false, "First call should insert audit (not deduped)");
    assertEquals(b1.event_deduplicated, false, "First call should insert event (not deduped)");

    // Second call with identical payload
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b2 = await r2.json();
    console.log("Second approve response:", b2);

    assertEquals(r2.status, 200, "Second call should succeed");

    // Keys must match between calls
    assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
    assertEquals(b2.event_idempotency_key, b1.event_idempotency_key, "Event keys should match");

    // Second call should be deduplicated
    assertEquals(b2.audit_deduplicated, true, "Audit should be deduplicated on retry");
    assertEquals(b2.event_deduplicated, true, "Event should be deduplicated on retry");
  },
});

Deno.test({
  name: "payout-actions: mark_paid is idempotent with normalized payment_reference",
  ignore: skipMarkPaidTests,
  async fn() {
    // Use messy whitespace/case to validate normalization
    const paymentRef = `  TEST-IDEMP-${Date.now()}  `;
    
    const payload = {
      action: "mark_paid",
      payout_id: TEST_PAYOUT_ID_APPROVED,
      payment_reference: paymentRef,
    };

    // First call
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b1 = await r1.json();
    console.log("First mark_paid response:", b1);

    // First call MUST succeed - if not, test setup is wrong
    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    assertEquals(b1.success, true, `First call should succeed: ${JSON.stringify(b1)}`);

    // Validate key format
    assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");
    assertValidIdempotencyKey(b1.event_idempotency_key, "event_idempotency_key");

    // First call should insert (NOT deduped)
    assertEquals(b1.audit_deduplicated, false, "First call should insert audit (not deduped)");
    assertEquals(b1.event_deduplicated, false, "First call should insert event (not deduped)");

    // Second call with identical payload (including same messy whitespace)
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b2 = await r2.json();
    console.log("Second mark_paid response:", b2);

    assertEquals(r2.status, 200, "Second call should succeed");

    // Keys must match (normalization should produce same hash)
    assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
    assertEquals(b2.event_idempotency_key, b1.event_idempotency_key, "Event keys should match");

    // Second call should be deduplicated
    assertEquals(b2.audit_deduplicated, true, "Audit should be deduplicated on retry");
    assertEquals(b2.event_deduplicated, true, "Event should be deduplicated on retry");
  },
});

Deno.test({
  name: "payout-actions: normalization dedupes whitespace/case variants in payment_reference",
  ignore: skipMarkPaidTests,
  async fn() {
    // This test verifies that the SAME logical payment ref with different formatting
    // produces the SAME idempotency key after normalization
    const baseRef = `test-norm-${Date.now()}`;
    
    // First call with lowercase, extra whitespace
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "mark_paid",
        payout_id: TEST_PAYOUT_ID_APPROVED,
        payment_reference: `  ${baseRef}  `,
      }),
    });
    const b1 = await r1.json();
    console.log("First normalized ref response:", b1);

    assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");

    // Second call with uppercase, different whitespace
    // After normalization (trim + uppercase), should produce same key
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "mark_paid",
        payout_id: TEST_PAYOUT_ID_APPROVED,
        payment_reference: `   ${baseRef.toUpperCase()}   `,
      }),
    });
    const b2 = await r2.json();
    console.log("Second normalized ref response:", b2);

    assertEquals(r2.status, 200);

    // After normalization, keys should match
    assertEquals(
      b2.audit_idempotency_key,
      b1.audit_idempotency_key,
      "Normalized payment refs should produce same key"
    );

    // Second call should be deduplicated
    assertEquals(b2.audit_deduplicated, true, "Normalized duplicate should be deduplicated");
  },
});

Deno.test({
  name: "payout-actions: reject normalization dedupes whitespace/case variants in reason",
  ignore: skipApproveTests,
  async fn() {
    // Use a pending payout for reject tests
    const baseReason = `test rejection ${Date.now()}`;
    
    // First call with lowercase
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "reject",
        payout_id: TEST_PAYOUT_ID_PENDING,
        reason: `  ${baseReason}  `,
      }),
    });
    const b1 = await r1.json();
    console.log("First reject response:", b1);

    if (r1.status === 200 && b1.success) {
      assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");

      // First call should NOT be deduplicated
      assertEquals(b1.audit_deduplicated, false, "First call should insert audit (not deduped)");

      // Second call with uppercase and different whitespace
      const r2 = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          action: "reject",
          payout_id: TEST_PAYOUT_ID_PENDING,
          reason: `   ${baseReason.toUpperCase()}   `,
        }),
      });
      const b2 = await r2.json();
      console.log("Second reject response:", b2);

      assertEquals(r2.status, 200);
      assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Normalized reasons should produce same key");
      assertEquals(b2.audit_deduplicated, true, "Should be deduplicated on retry");
    } else {
      // If first call fails (payout already rejected), that's a test setup issue
      assertEquals(r1.status, 200, `Expected 200 but got ${r1.status}: ${JSON.stringify(b1)}`);
    }
  },
});

Deno.test({
  name: "payout-actions: verify event_type normalization consistency",
  // NOTE: Requires service_role or staff RPC to query account_events
  // Keep ignored for automated runs; use for manual verification
  ignore: true,
  async fn() {
    // This test would verify:
    // 1. Query account_events for a known payout
    // 2. Check event_type column equals normalized value
    // 3. Check event_data.raw_event_type equals original mapping
    // 
    // Requires elevated privileges - run manually with service_role
    console.log("This test requires service_role access to query account_events");
  },
});

Deno.test({
  name: "payout-actions: unauthorized request returns 401",
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth header
      },
      body: JSON.stringify({
        action: "approve",
        payout_id: "00000000-0000-0000-0000-000000000000",
      }),
    });
    
    const body = await res.text();
    assertEquals(res.status, 401, `Expected 401, got ${res.status}: ${body}`);
  },
});

Deno.test({
  name: "payout-actions: missing payout_id returns 400",
  ignore: !ADMIN_TOKEN,
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "approve",
        // Missing payout_id
      }),
    });
    
    const body = await res.json();
    assertEquals(res.status, 400);
    assertExists(body.error);
  },
});

Deno.test({
  name: "payout-actions: invalid action returns 400",
  ignore: !ADMIN_TOKEN,
  async fn() {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "invalid_action",
        payout_id: "00000000-0000-0000-0000-000000000000",
      }),
    });
    
    const body = await res.json();
    assertEquals(res.status, 400);
    assertExists(body.error);
  },
});
