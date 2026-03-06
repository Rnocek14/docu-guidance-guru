# Full Architecture & Duplication Audit
**Date:** 2026-03-06  
**Scope:** All edge functions, RPCs, DB triggers, cron jobs, bridge adapters, scoring systems, payout/risk logic, admin tools, frontend dashboards  

---

## EXECUTIVE SUMMARY

The Meridian platform is architecturally mature with strong idempotency patterns, fail-closed safety gates, and a well-separated concern model. The core pipeline (ingest → breach → pass → payout → payment) is production-grade.

**However, the audit found 7 high-priority issues:**

1. **TIER_CONFIG duplicated in 4 places** with contradictory values (splitPercent, lifetimeCapMultiple, firstPayoutCap differ between files)
2. **normalizeSymbol duplicated in 3 places** — reconcile-trades has its own copy instead of importing the shared module
3. **Cluster risk managed by 2 writers** — `collect-fingerprint` EF and `evaluate_cluster_risk` RPC both write to `identity_clusters` with slightly different logic
4. **constantTimeEqual duplicated in 4 files** — should be a shared utility
5. **generateDeterministicKey duplicated in 2 files** — identical code in payout-actions and review-actions
6. **Frontend pricing-data.ts contradicts backend TIER_CONFIG** — lifetimeCapMultiple=10 (frontend) vs 7/9/12 (backend), firstPayoutCap=500 (frontend) vs 300/500/750 (backend)
7. **get-admin-readiness and get-tier-readiness are near-identical** — ~70% code overlap

**Verdict: CONDITIONAL GO** — The core pipeline is sound. Fix items #1 and #6 (tier config contradiction) before launch. Items #2-5 are cleanup for code health. Item #7 is debt.

---

## SECTION 1: SYSTEM INVENTORY

### A. Edge Functions (25 total)

| # | Function | Purpose | Auth | Tables Touched | Status |
|---|----------|---------|------|----------------|--------|
| 1 | `ingest-trade` | Broker webhook → canonical trade → `ingest_trade_atomic` RPC | Broker signature | trades, accounts, violations, account_events, audit_logs | **Canonical** |
| 2 | `payout-actions` | Admin payout workflow (approve/reject/initiate/mark_paid) | Admin JWT | payouts, payout_payments, accounts, audit_logs, account_events, fraud_reviews | **Canonical** |
| 3 | `review-actions` | Admin risk review (confirm_failure/clear_breach/escalate/close_flag) | Staff JWT | accounts, violations, flags, audit_logs, account_events | **Canonical** |
| 4 | `evaluate-risk-throttle` | Cron: calculates pass rates, sets throttle state | Cron/Admin | risk_throttle_state, cron_http_runs | **Canonical** |
| 5 | `system-governor` | Cron: 4-domain safety check, auto-lock/unlock | Cron/Admin | governor_certifications, payment_system_state, system_settings, staff_notifications | **Canonical** |
| 6 | `daily-risk-snapshot` | Cron: aggregated risk metrics + alarms | Cron/Admin | risk_snapshots, staff_notifications | **Canonical** |
| 7 | `check-dispute-rate` | Cron: Stripe dispute monitoring + auto-pause | Cron/Admin | payment_system_state, staff_notifications, cron_http_runs | **Canonical** |
| 8 | `check-liability-alert` | Cron: net buffer check → email alerts | Service role | liability_alerts (via RPC) | **Canonical** |
| 9 | `compute-cpc` | Cron: Capital Position Composite score | Cron/Admin | cpc_snapshots, staff_notifications | **Canonical** |
| 10 | `create-checkout-session` | User checkout → Stripe session | User JWT | checkout_fulfillment_queue, risk_throttle_state | **Canonical** |
| 11 | `stripe-webhook` | Stripe events → fulfillment queue | Stripe signature | checkout_fulfillment_queue, accounts | **Canonical** |
| 12 | `payment-webhook` | Generic payment provider webhooks | Provider-specific | payment_transactions | **Canonical** |
| 13 | `payout-webhook-handler` | Wise transfer state → confirm/fail payout | Wise RSA signature | payouts, payout_payments | **Canonical** |
| 14 | `payout-sla-check` | Cron: payout SLA escalation notifications | Cron secret | staff_notifications | **Canonical** |
| 15 | `reconcile-trades` | Staff-initiated trade reconciliation | Staff JWT | reconciliation_runs, audit_logs | **Canonical** |
| 16 | `collect-fingerprint` | User device fingerprint collection | User JWT | device_fingerprints, identity_clusters | **Canonical (with overlap)** |
| 17 | `admin-actions` | Generic admin ops (toggle_intake, audit_log) | Admin JWT | system_settings, audit_logs | **Canonical** |
| 18 | `get-admin-readiness` | Admin dashboard: launch readiness + Stripe verify | Admin JWT | cohorts, econ_breaker_state, risk_snapshots, payment_system_state | **Duplicate (see #19)** |
| 19 | `get-tier-readiness` | Admin dashboard: per-tier Stripe readiness | Admin JWT | cohorts, econ_breaker_state | **Duplicate (see #18)** |
| 20 | `get-pass-rate-stats` | Admin dashboard: per-tier pass rates | Staff JWT | accounts, cohorts | **Canonical** |
| 21 | `scenario-replay` | Certification harness: deterministic trade replay | Cron/Admin | accounts, trades, violations, flags, fraud_reviews, device_fingerprints | **Canonical (test-only)** |
| 22 | `bridge-smoke-test` | Adapter contract validation (dry-run/live) | Cron/Admin | collapse_sim_runs, platform_accounts | **Canonical (test-only)** |
| 23 | `qa-full-scan` | QA invariant scanner | Admin JWT | payouts, accounts, audit_logs, econ_breaker_state | **Canonical (test-only)** |
| 24 | `qa-approve-payout` | QA payout approval test | Admin JWT | payouts (via payout-actions) | **Canonical (test-only)** |
| 25 | `seed-demo-data` | Demo data seeder | Service role | accounts, trades, payouts | **Canonical (test-only)** |
| 26 | `run-simulation` | Monte Carlo simulation | Admin JWT | simulation_runs | **Canonical** |
| 27 | `run-sweep` | Parameter sweep | Admin JWT | collapse_sim_runs | **Canonical** |
| 28 | `retry-fulfillment-queue` | Cron: retry failed fulfillments | Cron secret | checkout_fulfillment_queue | **Canonical** |
| 29 | `process-support-email` | AI support email processing | Service role | support_emails, ai_usage_log | **Canonical** |
| 30 | `send-support-reply` | Send support reply email | Admin JWT | support_emails | **Canonical** |
| 31 | `evidence-pack` | Generate evidence pack for disputes | Staff JWT | accounts, trades, audit_logs | **Canonical** |
| 32 | `get-tier-readiness` | Tier readiness check | Admin JWT | Same as get-admin-readiness | **Should merge into get-admin-readiness** |

### B. Key SQL RPCs (source of truth for business logic)

| RPC | Purpose | Called By |
|-----|---------|----------|
| `ingest_trade_atomic` | Atomic trade ingestion + balance update + breach detection | ingest-trade EF |
| `calculate_payout_eligibility` | Server-side payout eligibility calculation | payout-actions EF |
| `try_auto_pass` | Atomic pass with FOR UPDATE lock | ingest-trade EF |
| `spawn_next_phase_account` | Create next-phase account on pass | ingest-trade EF |
| `check_consistency_rules` | Best-day cap + profitable days check | ingest-trade EF |
| `detect_trade_correlations` | Same-symbol cross-account hedging detection | payout-actions EF |
| `detect_cross_instrument_correlations` | Cross-instrument hedging (ES vs NQ) | payout-actions EF |
| `evaluate_cluster_risk` | Cluster-based fraud flag/review creation | scenario-replay, DB trigger |
| `confirm_payout_payment` | Mark payout as paid + update lifetime totals | payout-webhook-handler EF |
| `fail_payout_payment` | Revert failed payout payment | payout-webhook-handler EF |
| `get_econ_guardrail_status` | Economic safety gate verdict | payout-actions, daily-risk-snapshot |
| `get_liability_snapshot` | Net buffer calculation | system-governor, daily-risk-snapshot, compute-cpc, get-admin-readiness |
| `get_rolling_pass_rate` | Window-based pass rate | daily-risk-snapshot |
| `get_dispute_rate_snapshot` | Dispute rate calculation | check-dispute-rate |
| `governor_apply_lock` | Atomic 3-switch lock/unlock | system-governor |
| `resolve_user_jurisdiction` | Determine user country from geo signals | payout-actions |
| `assert_user_jurisdiction_allowed` | Check if action allowed in user's country | payout-actions |
| `check_geo_mismatch` | Detect conflicting location signals | payout-actions |
| `update_risk_throttle` | Upsert risk throttle state | evaluate-risk-throttle |
| `propose_econ_auto_tightening` | Auto-generate safety setting proposals | daily-risk-snapshot |
| `has_role` / `has_any_role` | Role check (SECURITY DEFINER) | All admin/staff EFs |

### C. DB Triggers

| Trigger | Table | Purpose |
|---------|-------|---------|
| `trg_fingerprint_cluster_risk` | `device_fingerprints` | Calls `evaluate_cluster_risk` on insert/update |
| Audit hash chain trigger | `audit_logs` | Computes `prev_hash` and `row_hash` on insert |
| `updated_at` triggers | Various | Auto-update timestamps |

### D. Cron Jobs (pg_cron)

| Job | Schedule | Edge Function |
|-----|----------|---------------|
| evaluate-risk-throttle | Every 6h | `evaluate-risk-throttle` |
| system-governor | Every 1h | `system-governor` |
| daily-risk-snapshot | Daily | `daily-risk-snapshot` |
| check-dispute-rate | Every 6h | `check-dispute-rate` |
| compute-cpc | Every 6h | `compute-cpc` |
| payout-sla-check | Every 1h | `payout-sla-check` |
| retry-fulfillment | Every 5m | `retry-fulfillment-queue` |
| check-liability-alert | Every 1h | `check-liability-alert` |

---

## SECTION A: DUPLICATE LOGIC REPORT

### A1: TIER_CONFIG — 4 copies, contradictory values ⚠️ CRITICAL

| Location | firstPayoutCap | splitPercent | lifetimeCapMultiple |
|----------|---------------|--------------|---------------------|
| `_shared/checkout/config.ts` | Not stored | Not stored | Not stored |
| `get-admin-readiness/index.ts` | 300/500/750 | 80/82/85 | 7/9/12 |
| `get-tier-readiness/index.ts` | 300/500/750 | 80/82/85 | 7/9/12 |
| `src/lib/pricing-data.ts` (frontend) | 500/500/500 | 80/80/80 | 10/10/10 |

**Contradiction:** Frontend shows uniform 80% split and 10x cap across all tiers. Backend has per-tier differentiation (80/82/85% split, 7/9/12x cap). The **database cohorts** are the true source of truth for enforcement, but the frontend misleads users.

**Canonical owner:** Database `cohorts` table  
**Action:** Delete tier economic params from all EF files. Frontend must read from cohorts or a single shared config. Fix `pricing-data.ts` to match cohort values.

### A2: normalizeSymbol — 3 copies

| Location | Notes |
|----------|-------|
| `_shared/brokers/normalize-symbol.ts` | **Canonical** — shared module |
| `reconcile-trades/index.ts` (lines 66-154) | **Duplicate** — full copy inlined |
| `reconcile-trades/normalizeSymbol.test.ts` | **Duplicate** — another copy for testing |

**Action:** `reconcile-trades/index.ts` should import from `../_shared/brokers/normalize-symbol.ts`. Delete the inlined copy. Move tests to test the shared module.

### A3: constantTimeEqual — 4 copies

| Location |
|----------|
| `daily-risk-snapshot/index.ts` |
| `check-dispute-rate/index.ts` |
| `retry-fulfillment-queue/index.ts` |
| `_shared/brokers/tradovate/adapter.ts` (sync version) |

**Action:** Extract to `_shared/crypto/constant-time.ts`. Import everywhere.

### A4: generateDeterministicKey — 2 copies

| Location |
|----------|
| `payout-actions/index.ts` |
| `review-actions/index.ts` |

**Action:** Extract to `_shared/crypto/deterministic-key.ts`.

### A5: insertAuditLog / insertAccountEvent — 2 copies

| Location |
|----------|
| `payout-actions/index.ts` |
| `review-actions/index.ts` |

Identical idempotent upsert pattern. **Action:** Extract to `_shared/audit/helpers.ts`.

### A6: get-admin-readiness vs get-tier-readiness — ~70% overlap

Both functions:
- Duplicate TIER_CONFIG with Stripe priceId/productId
- Duplicate Stripe deep verification logic
- Duplicate breaker state checks
- Duplicate cohort readiness checks

**Action:** Merge `get-tier-readiness` into `get-admin-readiness`. The readiness endpoint already returns per-tier data.

### A7: Auth boilerplate — duplicated in every EF

Every edge function reimplements JWT validation + role check (15-30 lines each). Not a bug, but significant maintenance burden.

**Action (future):** Extract to `_shared/auth/guard.ts`. Lower priority.

---

## SECTION B: CONTRADICTION REPORT

### B1: Frontend vs Backend Tier Economics ⚠️ CRITICAL

| Parameter | Frontend (pricing-data.ts) | Backend (get-admin-readiness) | DB (cohorts) |
|-----------|---------------------------|-------------------------------|-------------|
| Starter firstPayoutCap | $500 | $300 | DB is source of truth |
| Starter lifetimeCapMultiple | 10x | 7x | DB is source of truth |
| Pro splitPercent | 80% | 82% | DB is source of truth |
| Elite splitPercent | 80% | 85% | DB is source of truth |
| Elite lifetimeCapMultiple | 10x | 12x | DB is source of truth |

**Impact:** Users see uniform 80%/10x on the marketing page. If DB enforces 7x for Starter, a user who expects 10x × $149 = $1,490 lifetime cap will actually hit 7x × $149 = $1,043. This **will** generate support disputes.

**Fix:** Synchronize `pricing-data.ts` to match DB cohort values. Or better: fetch from a shared API endpoint.

### B2: Cluster Risk — Dual Writers

**Writer 1:** `collect-fingerprint` EF — directly updates `identity_clusters.risk_score` and `is_flagged` using simple count-based logic.

**Writer 2:** `evaluate_cluster_risk` RPC — called by DB trigger `trg_fingerprint_cluster_risk` on `device_fingerprints` insert/update. Uses selective backfill pattern with fraud_reviews and flags.

**Contradiction risk:** If `collect-fingerprint` creates a cluster and sets `risk_score=2, is_flagged=true`, then the trigger fires `evaluate_cluster_risk` which may overwrite those values OR create additional artifacts. The two paths don't coordinate.

**Action:** `collect-fingerprint` should ONLY handle fingerprint upsert and cluster creation/linking. All risk assessment (flagging, scoring, fraud_review creation) should be delegated to `evaluate_cluster_risk` via the DB trigger. Remove direct `identity_clusters.update({risk_score, is_flagged})` from `collect-fingerprint`.

### B3: Pass Rate Calculation — 2 approaches

- `evaluate-risk-throttle`: Counts `passed` and `failed_confirmed` accounts using `passed_at`/`failed_at` timestamps
- `get-pass-rate-stats`: Counts `passed` and `failed_confirmed` using `updated_at` (which drifts)
- `econ_breaker_state`: Stores `rolling_pass_rate` computed by unknown mechanism

**Risk:** `get-pass-rate-stats` uses `updated_at` which changes on any account update, not just resolution. This can include accounts from outside the intended window.

**Action:** `get-pass-rate-stats` should use `passed_at`/`failed_at` like `evaluate-risk-throttle` does.

---

## SECTION C: LEGACY / DEAD CODE REPORT

### C1: get-tier-readiness — should be merged

Near-complete duplicate of `get-admin-readiness`. The readiness dashboard already calls `get-admin-readiness` which returns per-tier data.

### C2: reconcile-trades inlined normalizeSymbol

154-line function that's identical to the shared module. Legacy from before the shared module was created.

### C3: Frontend simulation files (potential dead weight)

Multiple test/simulation files in `src/lib/` that may or may not still serve active purposes:
- `honest-tail-risk-analysis.test.ts`
- `slow-growth-deep-analysis.test.ts`
- `velocity-gate-analysis.test.ts`
- `volume-sensitivity-analysis.test.ts`
- `pass-rate-sensitivity.test.ts`

These appear to be analysis artifacts. **Not harmful** but add to project size.

---

## SECTION D: SOURCE OF TRUTH REPORT

| Domain | Canonical Owner | Notes |
|--------|----------------|-------|
| **Rule enforcement** | `ingest_trade_atomic` RPC (uses `rule_snapshot` frozen at account creation) | ✅ Clear |
| **Breach detection** | `ingest_trade_atomic` RPC | ✅ Clear — EF records violations post-atomic |
| **Pass detection** | `ingest-trade` EF → `try_auto_pass` RPC | ✅ Clear — atomic with FOR UPDATE lock |
| **fraud_reviews creation** | `payout-actions` EF (correlations), `evaluate_cluster_risk` RPC (clusters), `collect-fingerprint` EF (device match) | ⚠️ Multiple writers — see B2 |
| **flags creation** | `evaluate_cluster_risk` RPC (cluster_abuse), `ingest_trade_atomic` (breach flags) | ✅ Mostly clear |
| **Account state transitions** | `ingest-trade` (active→breached, active→passed), `review-actions` (breached→failed/active), `payout-actions` (account status on payout) | ✅ Clear — each action has distinct from/to states |
| **Payout state changes** | `payout-actions` EF (approve/reject/initiate), `payout-webhook-handler` (confirm/fail via RPC) | ✅ Clear |
| **Bridge normalization** | `_shared/brokers/normalize-symbol.ts` | ⚠️ Duplicated in reconcile-trades |
| **Risk-line calculation** | `ingest_trade_atomic` RPC (backend), trader dashboard components (frontend) | ✅ Parity tested by scenario-replay |
| **Score generation** | `compute-cpc` (CPC), `evaluate-risk-throttle` (throttle), `daily-risk-snapshot` (alarms) | ✅ Separate concerns |
| **Tier economics** | `cohorts` table | ⚠️ Contradicted by 3 hardcoded copies |

---

## SECTION E: TEST COVERAGE REPORT

| System | Scenario Replay | Unit Tests | QA Scan | Bridge Test | Manual |
|--------|----------------|------------|---------|-------------|--------|
| Trade ingestion + breach | ✅ | — | — | ✅ (dry-run) | — |
| Auto-pass detection | ✅ | — | — | — | — |
| Phase transitions | ✅ | — | — | — | — |
| Payout approval flow | — | ✅ (guardrail, idempotency) | ✅ | — | — |
| Review actions | — | ✅ (idempotency) | ✅ | — | — |
| Cluster/fingerprint abuse | ✅ (7-point) | — | — | — | — |
| Cross-instrument correlation | ✅ | — | — | — | — |
| Risk throttle | — | ✅ (decide function) | — | — | — |
| System governor | — | ✅ (contract) | — | — | — |
| Dispute rate monitoring | — | — | — | — | ❌ No test |
| Liability alerts | — | — | — | — | ❌ No test |
| CPC scoring | — | — | — | — | ❌ No test |
| Payout SLA escalation | — | — | — | — | ❌ No test |
| Stripe checkout + fulfillment | — | — | — | — | ❌ No test |
| Wise webhook handler | — | — | — | — | ❌ No test |
| Reconciliation | — | ✅ (normalizeSymbol) | — | — | — |
| DB invariants | — | — | ✅ (D1-D10) | — | — |
| Audit chain integrity | — | — | ✅ (D2) | — | — |
| Frontend simulation libs | — | ✅ (6+ test files) | — | — | — |

**Gaps:** check-dispute-rate, check-liability-alert, compute-cpc, payout-sla-check, stripe-webhook, payout-webhook-handler, create-checkout-session have no automated end-to-end tests.

---

## SECTION F: CRITICAL ISSUES (Top 10)

| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| 1 | 🔴 CRITICAL | Frontend pricing-data.ts contradicts DB cohort values (lifetimeCapMultiple, firstPayoutCap, splitPercent) | Users see wrong economic terms → support disputes, trust damage |
| 2 | 🔴 CRITICAL | TIER_CONFIG hardcoded in 4 places with different economic params | Configuration drift → incorrect readiness checks, misleading admin dashboards |
| 3 | 🟡 HIGH | collect-fingerprint and evaluate_cluster_risk both write cluster risk_score/is_flagged | Race condition, potential overwrite of production-owned control logic |
| 4 | 🟡 HIGH | get-pass-rate-stats uses updated_at instead of passed_at/failed_at | Pass rate stats may include wrong accounts → misleading admin metrics |
| 5 | 🟡 HIGH | normalizeSymbol duplicated in reconcile-trades (can drift from shared module) | Reconciliation could produce different symbol comparisons than ingestion |
| 6 | 🟡 MEDIUM | No automated tests for check-dispute-rate, payout-webhook-handler, stripe-webhook | Critical money paths untested end-to-end |
| 7 | 🟡 MEDIUM | constantTimeEqual duplicated 4× | Maintenance burden, risk of inconsistent behavior if one copy is updated |
| 8 | 🟡 MEDIUM | generateDeterministicKey + insertAuditLog duplicated 2× | Same risk — code can drift |
| 9 | 🟢 LOW | get-tier-readiness is a near-complete duplicate of get-admin-readiness | Wasted code, double maintenance |
| 10 | 🟢 LOW | Auth boilerplate repeated in every EF (15-30 lines each) | Maintenance burden (not a correctness issue) |

---

## SECTION G: CLEANUP PLAN (Prioritized)

### Phase 1: Pre-Launch (Must Fix)

1. **Fix pricing-data.ts to match DB cohorts** — Either fetch from API or hardcode correct values. Ensure /rules page, checkout, and comparison table all show correct lifetimeCapMultiple, firstPayoutCap, splitPercent per tier.

2. **Consolidate TIER_CONFIG** — Create `_shared/checkout/tier-economics.ts` with all economic params. `get-admin-readiness` and `get-tier-readiness` import from there. Delete duplicates.

3. **Fix get-pass-rate-stats** — Change from `updated_at` to `passed_at`/`failed_at` for accurate windowing.

### Phase 2: Pre-Scale (Should Fix)

4. **Remove cluster writes from collect-fingerprint** — Let the DB trigger + `evaluate_cluster_risk` RPC handle all risk assessment. `collect-fingerprint` should only upsert the fingerprint row and create/link clusters (no risk_score/is_flagged writes).

5. **Import normalizeSymbol in reconcile-trades** — Delete the inlined copy (lines 66-154). Import from `../_shared/brokers/normalize-symbol.ts`.

6. **Extract shared utilities** — `constantTimeEqual` → `_shared/crypto/constant-time.ts`, `generateDeterministicKey` + `insertAuditLog` + `insertAccountEvent` → `_shared/audit/helpers.ts`.

### Phase 3: Post-Launch (Nice to Have)

7. **Merge get-tier-readiness into get-admin-readiness** — Or delete get-tier-readiness if unused.

8. **Extract shared auth guard** — `_shared/auth/guard.ts` with JWT validation + role check.

9. **Add end-to-end tests** for dispute-rate, liability-alert, CPC, SLA, Stripe/Wise webhook handlers.

---

## LAUNCH READINESS VERDICT

### **CONDITIONAL GO**

**Blockers for unconditional GO:**
- [ ] Fix `pricing-data.ts` tier economics to match DB cohorts (Issue #1)
- [ ] Verify which TIER_CONFIG values are authoritative (Issue #2) — if DB cohorts say 10x, update the EF copies; if EFs say 7x, update the DB

**Acceptable for launch (fix within 2 weeks):**
- [ ] Fix get-pass-rate-stats windowing (Issue #4)
- [ ] Consolidate cluster risk writers (Issue #3)
- [ ] Import shared normalizeSymbol (Issue #5)

**The core pipeline (ingest → breach → pass → payout → payment) is structurally sound.** Idempotency is well-implemented, audit trails are comprehensive, fail-closed gates are properly wired. The issues found are configuration drift and code duplication, not architectural defects.
