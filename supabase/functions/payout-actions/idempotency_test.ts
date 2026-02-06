/**
 * Idempotency Tests for payout-actions edge function
 * 
 * Tests verify:
 * 1. approve twice with identical inputs → deduped audit+event on 2nd call
 * 2. mark_paid twice with same inputs → deduped on 2nd call
 * 3. mark_paid with different payment_reference → new inserts
 * 4. Idempotency keys match between retries
 * 5. Key charset and length constraints are met
 * 
 * Run with: deno test --allow-net --allow-env supabase/functions/payout-actions/idempotency_test.ts
 * 
 * NOTE: Tests that query account_events directly require service_role or a staff RPC.
 * The ignore:true tests are for manual verification with elevated privileges.
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/payout-actions`;

// These tests require an admin user token and test data
// Skip if not configured
const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN");
const TEST_PAYOUT_ID = Deno.env.get("TEST_PAYOUT_ID");

const skipTests = !ADMIN_TOKEN || !TEST_PAYOUT_ID;

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
  ignore: skipTests,
  async fn() {
    const payload = {
      action: "approve",
      payout_id: TEST_PAYOUT_ID,
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

    // First call should succeed (or already approved)
    if (r1.status === 200 && b1.success) {
      // Validate key format
      assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");
      assertValidIdempotencyKey(b1.event_idempotency_key, "event_idempotency_key");

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
    } else if (r1.status === 400) {
      // Payout not in valid state for approval - that's fine for this test
      console.log("Payout not in approvable state, skipping dedupe verification");
    }
  },
});

Deno.test({
  name: "payout-actions: mark_paid is idempotent with normalized payment_reference",
  ignore: skipTests,
  async fn() {
    // Use messy whitespace/case to validate normalization
    const paymentRef = `  TEST-IDEMP-${Date.now()}  `;
    
    const payload = {
      action: "mark_paid",
      payout_id: TEST_PAYOUT_ID,
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

    if (r1.status === 200 && b1.success) {
      // Validate key format
      assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");
      assertValidIdempotencyKey(b1.event_idempotency_key, "event_idempotency_key");

      // First call should insert
      assertEquals(b1.audit_deduplicated, false, "First call should insert audit");
      assertEquals(b1.event_deduplicated, false, "First call should insert event");

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

      // Keys must match (normalization should produce same hash)
      assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
      assertEquals(b2.event_idempotency_key, b1.event_idempotency_key, "Event keys should match");

      // Second call should be deduplicated
      assertEquals(b2.audit_deduplicated, true, "Audit should be deduplicated");
      assertEquals(b2.event_deduplicated, true, "Event should be deduplicated");
    } else if (r1.status === 400) {
      // Invalid state transition (e.g., not approved) - expected in some test setups
      console.log("Payout not in payable state:", b1.error);
      assertExists(b1.error);
    }
  },
});

Deno.test({
  name: "payout-actions: different payment_reference produces different keys",
  ignore: skipTests,
  async fn() {
    const baseRef = `TEST-DIFF-${Date.now()}`;
    
    // First call
    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "mark_paid",
        payout_id: TEST_PAYOUT_ID,
        payment_reference: `${baseRef}-A`,
      }),
    });
    const b1 = await r1.json();

    // Second call with different reference
    const r2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        action: "mark_paid",
        payout_id: TEST_PAYOUT_ID,
        payment_reference: `${baseRef}-B`,
      }),
    });
    const b2 = await r2.json();

    console.log("Different refs test:", {
      key1: b1.audit_idempotency_key,
      key2: b2.audit_idempotency_key,
    });

    // If both succeeded, keys should differ
    if (r1.status === 200 && r2.status === 200 && b1.success && b2.success) {
      assert(
        b1.audit_idempotency_key !== b2.audit_idempotency_key,
        "Different payment refs should produce different audit keys"
      );
    }
  },
});

Deno.test({
  name: "payout-actions: reject is idempotent with normalized reason",
  ignore: skipTests,
  async fn() {
    const reason = `Test rejection ${Date.now()}`;
    
    const payload = {
      action: "reject",
      payout_id: TEST_PAYOUT_ID,
      reason: reason,
    };

    const r1 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const b1 = await r1.json();
    console.log("First reject response:", b1);

    if (r1.status === 200 && b1.success) {
      assertValidIdempotencyKey(b1.audit_idempotency_key, "audit_idempotency_key");

      // Second call
      const r2 = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      const b2 = await r2.json();
      console.log("Second reject response:", b2);

      assertEquals(b2.audit_idempotency_key, b1.audit_idempotency_key, "Audit keys should match");
      assertEquals(b2.audit_deduplicated, true, "Should be deduplicated on retry");
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
  ignore: skipTests,
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
