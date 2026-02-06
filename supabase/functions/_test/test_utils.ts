/**
 * Shared test utilities for edge function idempotency tests
 * 
 * This module provides consistent validation helpers and constants
 * for both payout-actions and review-actions test suites.
 */

import { assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

// =============================================
// KEY FORMAT CONSTANTS
// =============================================

/**
 * Valid charset for idempotency keys:
 * - alphanumeric (a-zA-Z0-9)
 * - colon (:) for namespace separation
 * - underscore (_) and hyphen (-) for readability
 * - dot (.) for namespace prefix
 */
export const KEY_REGEX = /^[a-zA-Z0-9:_\-.]+$/;

/** Minimum key length (ensures sufficient entropy) */
export const KEY_MIN_LENGTH = 10;

/** Maximum key length (database constraint) */
export const KEY_MAX_LENGTH = 200;

// =============================================
// KEY NAMESPACE PREFIXES
// =============================================

/** Prefix for audit_logs idempotency keys */
export const AUDIT_KEY_PREFIX = "audit.";

/** Prefix for account_events idempotency keys */
export const EVENT_KEY_PREFIX = "acctevt.";

// =============================================
// VALIDATION HELPERS
// =============================================

/**
 * Assert that an idempotency key meets all database constraints:
 * - exists (not null/undefined)
 * - matches allowed charset
 * - meets length requirements (10-200 chars)
 * 
 * @param key - The idempotency key to validate
 * @param label - Descriptive label for error messages
 */
export function assertValidIdempotencyKey(key: string, label: string): void {
  assertExists(key, `${label} should exist`);
  assert(
    KEY_REGEX.test(key),
    `${label} should match charset constraint (alphanumeric + :_-.): ${key}`
  );
  assert(
    key.length >= KEY_MIN_LENGTH,
    `${label} should be >= ${KEY_MIN_LENGTH} chars, got ${key.length}: ${key}`
  );
  assert(
    key.length <= KEY_MAX_LENGTH,
    `${label} should be <= ${KEY_MAX_LENGTH} chars, got ${key.length}`
  );
}

/**
 * Assert that an audit idempotency key has the correct namespace prefix.
 * Keys should start with "audit." to prevent cross-table collisions.
 * 
 * @param key - The audit idempotency key to validate
 * @param label - Descriptive label for error messages
 */
export function assertAuditKeyPrefix(key: string, label: string = "audit_idempotency_key"): void {
  assert(
    key.startsWith(AUDIT_KEY_PREFIX),
    `${label} must start with '${AUDIT_KEY_PREFIX}', got: ${key.slice(0, 20)}...`
  );
}

/**
 * Assert that an event idempotency key has the correct namespace prefix.
 * Keys should start with "acctevt." to prevent cross-table collisions.
 * 
 * @param key - The event idempotency key to validate
 * @param label - Descriptive label for error messages
 */
export function assertEventKeyPrefix(key: string, label: string = "event_idempotency_key"): void {
  assert(
    key.startsWith(EVENT_KEY_PREFIX),
    `${label} must start with '${EVENT_KEY_PREFIX}', got: ${key.slice(0, 20)}...`
  );
}

/**
 * Full validation for audit idempotency keys:
 * - Valid format (charset, length)
 * - Correct namespace prefix
 * 
 * @param key - The audit idempotency key to validate
 * @param label - Descriptive label for error messages
 */
export function assertValidAuditKey(key: string, label: string = "audit_idempotency_key"): void {
  assertValidIdempotencyKey(key, label);
  assertAuditKeyPrefix(key, label);
}

/**
 * Full validation for event idempotency keys:
 * - Valid format (charset, length)
 * - Correct namespace prefix
 * 
 * @param key - The event idempotency key to validate
 * @param label - Descriptive label for error messages
 */
export function assertValidEventKey(key: string, label: string = "event_idempotency_key"): void {
  assertValidIdempotencyKey(key, label);
  assertEventKeyPrefix(key, label);
}

// =============================================
// RESPONSE SHAPE HELPERS
// =============================================

/**
 * Assert that dedupe fields are present and correctly typed in a response body.
 * Use after a successful (200) call to verify the response contract.
 * 
 * For audit-only actions (like add_note), pass hasEvent=false.
 * For state-changing actions that emit events, pass hasEvent=true (default).
 */
export function assertDedupeFieldTypes(
  body: Record<string, unknown>,
  hasEvent: boolean = true,
  label: string = "response"
): void {
  // Pick the correct audit dedupe field (some actions use `deduplicated` alias)
  const auditDedupe = body.audit_deduplicated ?? body.deduplicated;
  assertEquals(
    typeof auditDedupe,
    "boolean",
    `${label}: audit_deduplicated (or deduplicated) must be boolean, got ${typeof auditDedupe}`
  );

  if (hasEvent) {
    assertEquals(
      typeof body.event_deduplicated,
      "boolean",
      `${label}: event_deduplicated must be boolean when event is emitted`
    );
    assertExists(body.event_idempotency_key, `${label}: event_idempotency_key must exist`);
    assertExists(body.event_type, `${label}: event_type must exist when event is emitted`);
    assertEquals(
      typeof body.event_type,
      "string",
      `${label}: event_type must be string when event is emitted`
    );
  } else {
    assertEquals(body.event_idempotency_key, null, `${label}: event_idempotency_key must be null when no event`);
    assertEquals(body.event_deduplicated, null, `${label}: event_deduplicated must be null when no event`);
    assertEquals(body.event_type, null, `${label}: event_type must be null when no event`);
  }
}

// =============================================
// ENV VAR HELPERS
// =============================================

/**
 * Soft check: prints a warning listing missing env vars.
 * Tests using these vars should set `ignore: !VAR` to skip gracefully.
 */
export function requireEnvVars(vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.warn(
      `⚠️  Missing env vars for idempotency tests: ${missing.join(", ")}\n` +
      `   Tests requiring these will be skipped.\n` +
      `   Set them in .env or pass via CLI to run full suite.`
    );
  }
}

/**
 * Hard check: throws if any env var is missing.
 * Use for tests that must never be silently skipped (e.g., CI acceptance tests).
 */
export function requireEnvVarsStrict(vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
      `Set them in .env or pass via CLI.`
    );
  }
}

// =============================================
// TEST DATA HELPERS
// =============================================

/**
 * Generate a unique timestamp-based suffix for test data.
 * Useful for creating distinct test inputs that won't collide.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
