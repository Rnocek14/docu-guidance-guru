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
// TEST DATA HELPERS
// =============================================

/**
 * Generate a unique timestamp-based suffix for test data.
 * Useful for creating distinct test inputs that won't collide.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
