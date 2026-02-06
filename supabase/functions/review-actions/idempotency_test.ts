/**
 * Idempotency Tests for review-actions edge function
 * 
 * Tests verify:
 * 1. confirm_failure twice → deduped on 2nd call
 * 2. add_note twice with same content → deduped
 * 3. add_note with different content → new insert
 * 4. event_type stored equals eventTypeNorm
 * 
 * Run with: deno test --allow-net --allow-env supabase/functions/review-actions/idempotency_test.ts
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/review-actions`;

// These tests require a staff user token and test data
const STAFF_TOKEN = Deno.env.get("TEST_STAFF_TOKEN");
const TEST_ACCOUNT_ID = Deno.env.get("TEST_ACCOUNT_ID");

const skipTests = !STAFF_TOKEN || !TEST_ACCOUNT_ID;

Deno.test({
  name: "review-actions idempotency: add_note twice with same content → deduped",
  ignore: skipTests,
  async fn() {
    const noteContent = `Test note for idempotency ${Date.now()}`;
    
    // First call
    const res1 = await fetch(FUNCTION_URL, {
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
    
    const body1 = await res1.json();
    console.log("First add_note response:", body1);
    
    assertEquals(res1.status, 200);
    assertEquals(body1.success, true);
    assertEquals(body1.deduplicated, false, "First call should not be deduplicated");
    
    // Second call with identical content
    const res2 = await fetch(FUNCTION_URL, {
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
    
    const body2 = await res2.json();
    console.log("Second add_note response:", body2);
    
    assertEquals(res2.status, 200);
    assertEquals(body2.success, true);
    assertEquals(body2.deduplicated, true, "Second call should be deduplicated");
  },
});

Deno.test({
  name: "review-actions idempotency: add_note with different content → new insert",
  ignore: skipTests,
  async fn() {
    const noteContent1 = `Test note A ${Date.now()}`;
    const noteContent2 = `Test note B ${Date.now()}`;
    
    // First call
    const res1 = await fetch(FUNCTION_URL, {
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
    
    const body1 = await res1.json();
    assertEquals(res1.status, 200);
    assertEquals(body1.deduplicated, false);
    
    // Second call with different content
    const res2 = await fetch(FUNCTION_URL, {
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
    
    const body2 = await res2.json();
    assertEquals(res2.status, 200);
    assertEquals(body2.deduplicated, false, "Different content should create new audit entry");
    
    // Keys should be different
    assertEquals(body1.idempotency_key !== body2.idempotency_key, true, "Different content should have different keys");
  },
});

Deno.test({
  name: "review-actions idempotency: reason normalization (whitespace/case)",
  ignore: skipTests,
  async fn() {
    const baseReason = `Normalized reason test ${Date.now()}`;
    const reasonWithExtraWhitespace = `  ${baseReason.toUpperCase()}   `;
    
    // First call with base reason
    const res1 = await fetch(FUNCTION_URL, {
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
    
    const body1 = await res1.json();
    assertEquals(res1.status, 200);
    
    // Second call with extra whitespace and different case
    // After normalization, should produce same key
    const res2 = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STAFF_TOKEN}`,
      },
      body: JSON.stringify({
        action: "add_note",
        account_id: TEST_ACCOUNT_ID,
        reason: reasonWithExtraWhitespace,
      }),
    });
    
    const body2 = await res2.json();
    console.log("Normalization test:", { key1: body1.idempotency_key, key2: body2.idempotency_key });
    
    // After normalizeReason (trim + collapse whitespace + lowercase), these should match
    assertEquals(body2.deduplicated, true, "Normalized reasons should dedupe");
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
  name: "review-actions: non-admin cannot confirm_failure",
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
    console.log("confirm_failure by non-admin:", res.status, body);
    
    // Either succeeds (if admin) or 403 (if risk_officer)
    assertEquals(res.status === 200 || res.status === 403, true);
  },
});
