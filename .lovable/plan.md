# Next Batch — P0/P1 Hardening

Scope interpreted from "make it best we can": treat resets as **v1 launch-blocker** and ship the reset endpoint alongside the audit fixes so P1-6 becomes a real fix, not just forward-compatible. If resets are actually post-launch, say so and I'll drop step 5.

## 1. P0-2 — Atomic refund RPC
- **New migration**: `handle_charge_refunded(p_charge_id, p_refund_id, p_amount, p_reason)` SECURITY DEFINER RPC.
  - `FOR UPDATE` on `payment_transactions` row by charge id.
  - Inside txn: mark transaction refunded, invalidate evaluation accounts created from it, write `audit_logs` entry (hash-chained), return `{ payouts_in_transit: int, account_ids: uuid[] }`.
  - Idempotent via unique constraint on `(charge_id, refund_id)`.
- **Rewrite `supabase/functions/refund-handler/index.ts`** as a thin wrapper:
  - Verify Stripe webhook signature → call RPC → if `payouts_in_transit > 0`, fire ops notification **outside** the RPC (Claude's correct callout: human-action signal, not DB state).
  - Mask 500s with generic message per INFO_LEAKAGE rule.

## 2. P1-3 — Retry cap in `markQueueError`
- Cap at 8 attempts. At the cap, transition to **`failed_retryable_exhausted`** (distinct terminal state — preserves operator visibility per recommendation).
- Add column/enum value via migration if needed; otherwise reuse existing status with a flag.
- Update operator queue UI filters to surface this state.

## 3. P1-1 + P1-2 — Migrate to `_v2` RPCs
- `checkout-handler.ts` → `fulfill_checkout_v2`.
- `retry-fulfillment-queue/index.ts` → `retry_fulfillment_v2`.
- Keep v1 callable for one prod cycle. **Drop-v1 migration is a separate PR** — not in this batch.

## 4. P1-8 — Tests (priority order)
1. Refund idempotency under concurrent invocation (two webhook deliveries, one row mutation).
2. Fulfillment retry classification (retryable vs terminal vs exhausted).
3. Wise webhook signature verification + state mapping.
4. WealthCharts adapter rejection contract.
5. CI guard: `tier-economics.ts` constants vs DB `cohort_configs` diff.

## 5. (Conditional, launch-blocker scope) Reset purchase endpoint
- **New edge function**: `checkout-reset` — Stripe Checkout session for `resetFee: 99` from `tier-economics.ts`.
- Writes `payment_transactions` with `purpose = 'reset_fee'` (matches the schema enum P1-6 already queries).
- Idempotency: 48-char deterministic key via `generateDeterministicKey` keyed on `(account_id, attempt_n)`.
- Re-arms the failed evaluation account; audit-logged.
- Test: asserts the row is written with exactly `purpose = 'reset_fee'` so P1-6's dashboard query lights up.

## Technical notes
- All new SQL via `supabase--migration`. Money-moving rows use `FOR UPDATE`; policy-state reads use `FOR SHARE`.
- Edge functions: `verify_jwt = false` defaults preserved; Stripe + cron paths use `constantTimeEqual` for any shared-secret compares.
- No `service_role_key` ever crosses to the client.
- Cron auth path: `X-Cron-Secret` + constant-time; admin JWT fallback unchanged.

## Sequencing
Step 1 → 2 → 3 → 5 (if in scope) → 4. Tests last so they exercise final shapes. Each step is committed independently so we can bisect if anything regresses.

## What I need from you
- **Reset scope confirmation**: launch-blocker (do step 5) or post-launch (skip step 5, leave P1-6 forward-compatible)?
- That's it — everything else is mechanical.
