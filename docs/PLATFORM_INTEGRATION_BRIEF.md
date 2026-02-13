# Meridian Prop Evaluation Platform — Integration Brief

**Prepared for:** Trading Infrastructure Partner  
**Version:** 1.0  
**Date:** 2026-02-13  
**Classification:** Confidential — Business Development

---

## Section 1 — Executive Overview

Meridian operates a simulated trading evaluation platform where traders purchase evaluation accounts, trade against defined rule sets, and earn performance-based rewards upon meeting structured criteria. Revenue is generated exclusively from evaluation entry fees ($149–$349 per tier). Traders never deposit trading capital; payouts are funded from evaluation revenue and governed by conservative caps: a $300–$750 first-payout ceiling, a 7×–12× lifetime cap on total payouts relative to entry fee, and a 30-day cooldown between requests. The platform maintains structural solvency through a three-tier pricing model, automated economic breaker circuits, and reserve-aware approval gates that halt outflows before capital is at risk.

### Revenue Model

| Component | Detail |
|-----------|--------|
| Entry Fees | $149 (Standard), $199 (Pro), $349 (Elite) |
| Payout Split | 80–85% to trader |
| First Payout Cap | $300–$750 (tier-dependent) |
| Lifetime Cap | 7×–12× entry fee |
| Cooldown | 30 days between payout requests |
| Reset Fees | Re-entry at full price after failure |

### Why the Model Is Structurally Conservative

1. **First payout cap** limits initial extraction to a fraction of entry fee revenue
2. **Lifetime cap** bounds total exposure per trader to a known multiple
3. **Economic breaker** automatically freezes operations if pass rates exceed structural inversion thresholds (~22%)
4. **Reserve-aware gate** blocks payout approvals when cash buffer is insufficient
5. **Velocity limits** prevent payout request spam (3/day per account, 5/day per user, $5,000/7-day rolling cap)

---

## Section 2 — Technical Architecture

### Database Structure

| Table | Purpose |
|-------|---------|
| `accounts` | Trader evaluation accounts with status, balance, rule snapshots |
| `cohorts` | Rule sets defining each evaluation tier and phase |
| `trades` | Individual trade records ingested from broker platforms |
| `payouts` | Payout request lifecycle (pending → approved → paid) |
| `payout_payments` | External payment provider records |
| `user_cohort_payouts` | Lifetime payout tracking per user per cohort |
| `audit_logs` | Tamper-evident hash-chained administrative action log |
| `account_events` | Trader-visible timeline of platform decisions |
| `flags` | Risk flags requiring manual review |
| `fraud_reviews` | Escalated fraud investigations |
| `violations` | Rule breach records linked to specific trades |
| `account_daily_stats` | Per-day P&L aggregation for consistency enforcement |
| `device_fingerprints` | Browser/device identity tracking |
| `identity_clusters` | Cross-user identity correlation groups |
| `chargeback_events` | Dispute tracking with automated freeze triggers |

### Account Lifecycle State Machine

```
┌──────────┐    profit target    ┌──────────┐    profit target    ┌─────────────┐
│  EVAL    │───────met──────────▶│  VERIFY  │───────met──────────▶│ PERFORMANCE │
│ (active) │                     │ (active) │                     │  (active)   │
└────┬─────┘                     └────┬─────┘                     └──────┬──────┘
     │                                │                                  │
     │ rule breach                    │ rule breach               payout request
     ▼                                ▼                                  ▼
┌──────────────┐              ┌──────────────┐              ┌────────────────────┐
│  breached_   │              │  breached_   │              │ payout_requested   │
│  detected    │              │  detected    │              └────────┬───────────┘
└──────┬───────┘              └──────┬───────┘                       │
       │ admin review                │                        admin review
       ▼                             ▼                               ▼
┌──────────────┐              ┌──────────────┐              ┌────────────────────┐
│   failed_    │              │   failed_    │              │ payout_approved     │
│  confirmed   │              │  confirmed   │              └────────┬───────────┘
└──────────────┘              └──────────────┘                       │
                                                              mark paid
                                                                     ▼
                                                             ┌──────────────┐
                                                             │ paid_confirmed│
                                                             └──────────────┘
```

Phase transitions are recorded in `account_phase_transitions` with idempotent unique constraints on `(from_account_id, to_cohort_id)`.

### Payout Lifecycle State Machine

```
pending → under_review → approved → payment_initiated → paid_confirmed
                  │                        │
                  └──▶ rejected             └──▶ failed
```

### Idempotency Safeguards

- All state-changing operations use deterministic SHA-256 idempotency keys (e.g., `mark_paid:{payout_id}:{ref}:{cents}`)
- Insert-only pattern with Postgres error code 23505 handling (no upserts on sensitive tables)
- Separate `idempotency_key` (text hash) and `request_id` (UUID) fields enforce type safety
- Webhook replay detection via `event_id_conflict` checks

### Audit Hash Chain

The `audit_logs` table implements a SHA-256 hash chain:

- Each row contains `row_hash` (hash of current row content) and `prev_hash` (hash of previous entry)
- Managed exclusively by database triggers — no application-layer writes
- Integrity verifiable via `verify_audit_chain` RPC
- All timestamps UTC-normalized for hash stability
- Client-side writes to audit tables are blocked by RLS

### RLS Enforcement Summary

| Access Level | Read | Write | Mutate |
|-------------|------|-------|--------|
| Traders | Own accounts, trades, events, payouts | Own payout methods only | No direct mutation of accounts, trades, payouts, violations |
| Staff (risk_officer, support) | All records | None | None |
| Admin | All records | Cohorts, flags, payment rails | Via Edge Functions only |
| Service Role | All (bypasses RLS) | All | Used only in Edge Functions |
| Anonymous/Public | None | Analytics events only | None |

All sensitive tables (accounts, trades, payouts, violations, audit_logs, flags) have RLS enabled with explicit deny policies for unauthorized operations.

### SECURITY DEFINER RPC Controls

- All money-moving RPCs (`mark_payout_paid`, `confirm_payout_payment`, `ingest_trade_atomic`) are `SECURITY DEFINER` owned by `postgres`
- Every such function includes `SET search_path = public` to prevent mutable search path attacks
- `EXECUTE` is revoked from `PUBLIC` and `anon` on all sensitive RPCs
- Access granted only to `service_role` (background tasks) or `authenticated` with staff role checks

### JWT Validation Architecture

Edge Functions use `verify_jwt = false` in gateway configuration to support:

- Custom signing-key architectures
- Automated cron tasks using `CRON_SECRET` bearer tokens
- Internal authorization via `user_roles` table lookup
- Fallback to `internal_secrets` table if environment variables are missing

This is a deliberate security architecture choice: JWT verification is performed application-side after extracting claims, not at the gateway layer.

---

## Section 3 — Risk Controls

### First Payout Cap

- Configurable per cohort via `first_payout_cap_amount`
- Standard tier: $300
- Enforced in `calculate_payout_eligibility` RPC
- Cannot be bypassed client-side (RLS blocks direct payout writes)

### Lifetime Cap Enforcement

- Defined as `lifetime_cap_multiple × entry_fee` per cohort (e.g., 7× $149 = $1,043)
- Tracked in `user_cohort_payouts.lifetime_paid_total`
- Enforced with `FOR UPDATE` row-level locks in `mark_payout_paid` to prevent race conditions
- Headroom calculated atomically: `cap - lifetime_paid_total - current_request`
- Concurrent requests for the same user/cohort are serialized via lock ordering

### Profit Buffer Enforcement

- `min_profit_buffer` (e.g., $200) must remain in account after payout
- Prevents extraction of entire account balance
- Checked in `calculate_payout_eligibility`

### Minimum Trading Days

- `min_trading_days` (5–10, configurable per cohort phase)
- `min_trading_days_between_payouts` enforces activity between consecutive payouts
- Tracked via `trading_days_count` on accounts and `account_daily_stats` row counts

### Minimum Winning Days

- `min_winning_days_between_payouts` (e.g., 3 for Performance phase)
- Ensures consistent profitability, not single-trade spikes

### Eligibility Delay

- `payout_eligibility_delay_days` (e.g., 14 days for Performance)
- Creates observation window before first payout eligibility
- Prevents "speed-run" extraction strategies

### Reserve-Aware Payout Approval Gate

- Blocks approvals when `cash_reserve - pending_liability < min_reserve_after_approval`
- Returns diagnostic codes: `RESERVE_AT_RISK` or `SIM_RISK_TOO_HIGH`
- Staff can override with mandatory justification (audit-logged)

### Economic Breaker

| Level | Trigger | Effect |
|-------|---------|--------|
| Normal | Pass rate < 18% | No restrictions |
| Warning | Pass rate 18–22% | Extended eligibility delays |
| Critical | Pass rate > 22% | Evaluations frozen, approvals blocked |
| Emergency | Manual or sustained critical | All payouts blocked |

- Monitors 30-day rolling pass rate
- Evaluated by `evaluate-risk-throttle` cron function
- State stored in singleton `econ_breaker_state` table

### Liability Snapshot

- Calculated via `get_liability_snapshot` RPC
- Formula: `Cash Reserve - Pending Liability - Projected 7-day Openings`
- Stale data warnings if snapshot > 26 hours old
- Drift detection between `profiles.lifetime_paid_total` and `user_cohort_payouts` source of truth

---

## Section 4 — Abuse & Fraud Mitigation

### Cross-Account Correlation

- `detect_trade_correlations` RPC checks for coordinated trading patterns across accounts sharing user attributes (device fingerprint, payout method hash)
- Blocks payouts and escalates to fraud review if threshold met

### Device Fingerprint Enforcement

- Browser fingerprint collected via `collect-fingerprint` Edge Function
- Stored in `device_fingerprints` with hash, IP, country, VPN detection
- Cross-referenced during payout requests
- Linked to `identity_clusters` for multi-account detection

### Cross-Instrument Hedging Detection

- `detect_cross_instrument_correlations` RPC monitors for opposing positions within 120-second windows
- Seeded correlation groups: Equity Indices (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K), Energy (CL, BZ), Metals (GC, SI, MGC, SIL)
- Minimum 3 matches triggers automatic payout block (403) and fraud review escalation

### Jurisdiction Enforcement

- Three-layer gating: UI, API, Database
- Signal priority: KYC > Billing > IP > Attested
- `assert_user_jurisdiction_allowed` blocks trading, purchases, and payouts for restricted regions
- Geo signals must use `signal_type = 'ip_country'` to be recognized

### Geo Mismatch Hold

- Automated hold triggered when KYC country conflicts with IP/billing location
- Manual release requires documented evidence notes in audit log

### Payout Double-Request Prevention

- `submit_payout_request` RPC acquires `FOR UPDATE` lock on account before processing
- Re-validates eligibility server-side within the lock
- Atomically transitions account status and inserts payout record
- Velocity limits: 3 requests/24h per account, 5/24h per user, $5,000/7-day rolling cap

### Separation of Duties

- `payouts.reviewed_by` (approver) must differ from payment initiator
- Enforced via Database RPCs with FK constraint requiring valid `auth.users` UUID
- `payout_payments.initiated_by` is `NOT NULL` without FK, allowing system-initiated payments

---

## Section 5 — Operational Controls

### Cron Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `daily-risk-snapshot` | Daily | Liability calculation, pass rate monitoring |
| `evaluate-risk-throttle` | Periodic | Breaker level evaluation |
| `check-dispute-rate` | Periodic | Stripe dispute rate monitoring (0.5% kill-switch) |
| `check-liability-alert` | Periodic | Net buffer threshold alerting |
| `retry-fulfillment-queue` | Periodic | Re-process blocked checkout fulfillments |
| `reconcile-trades` | Daily | Trade data integrity verification |

All cron jobs monitored via `cron_health_config` and `cron_http_runs` tables with configurable success rate thresholds (red < 50%, yellow < 90%).

### Liability Alert Thresholds

- Current cash reserve: $15,000
- Alert threshold: $5,000 (triggers when net buffer drops below)
- Assumed average first payout: $300
- Cooldown: 60 minutes between alerts
- Channels: email + in-app

### Admin Dashboards

- `/admin/readiness` — "Safe to Sell" executive gate (fail-closed)
- `/admin/liability` — Real-time payout exposure visibility
- `/admin/system` — Kill switches and payment system state
- `/admin/ops-metrics` — Operational health monitoring
- `/admin/monte-carlo` — Monte Carlo simulation analytics
- `/admin/qa-scan` — Automated integrity scan runner

### Support AI Triage

- Fail-closed system: hallucinated facts detected and stripped
- Server-side `validateFactsUsed` performs token-overlap and anchor-token checks
- 500k daily token cap, 2k per email
- `human_override` feedback loop for prompt tuning
- All actions recorded in `support_email_actions`
- `ai_status` tracking: complete, skipped_cap, not_grounded, no_context

### Audit Reconstruction

- Every support AI response includes `prompt_version` and `context_hash`
- `facts_used` array cites specific account data snippets
- Full chain reconstructible: email → AI response → facts_used → context_hash → audit action

---

## Section 6 — Capital & Survivability Model

### Entry Fee vs Payout Exposure

| Tier | Entry Fee | First Cap | Lifetime Cap | Break-Even Pass Rate |
|------|-----------|-----------|-------------|---------------------|
| Standard | $149 | $300 | $1,043 (7×) | ~16% |
| Pro | $199 | $500 | $1,990 (10×) | ~17% |
| Elite | $349 | $750 | $4,188 (12×) | ~18% |

### First Payout Burst Containment

- At $15,000 reserve and $300 first cap: 50 simultaneous first payouts exhaust reserve
- At 12% pass rate: 400 evals produce ~48 funded traders
- Operating target: 200–300 evals/month for comfortable margin

### Lifetime Exposure Containment

- Standard tier trader lifetime max: $1,043
- At 12% pass rate with 200 evals/month: 24 funded × $1,043 = $25,032 theoretical max lifetime exposure
- Spread across 12+ months due to cooldown periods and natural attrition

### Reserve Requirements

| Monthly Evals | Pass Rate | Funded | First Payout Exposure | Reserve Needed |
|--------------|-----------|--------|----------------------|----------------|
| 200 | 12% | 24 | $7,200 | $10,000+ |
| 300 | 12% | 36 | $10,800 | $15,000+ |
| 400 | 15% | 60 | $18,000 | $25,000+ |
| 400 | 20% | 80 | $24,000 | $30,000+ |

### Structural Thresholds

- **Structural inversion point:** 14% pass rate (lifetime max payouts exceed initial revenue)
- **First-cap break-even:** 49.5% pass rate at $149 entry (for $300 cap alone)
- **Operating target:** 10–12% pass rate
- **Danger zone:** sustained >22% pass rate

---

## Section 7 — Infrastructure Requirements for Platform Partner

### Trade Ingestion

| Requirement | Detail |
|-------------|--------|
| Protocol | Webhook (HTTPS POST) or REST API polling |
| Format | JSON with documented schema |
| Authentication | HMAC signature verification + anti-replay timestamps |
| Latency tolerance | < 30 seconds from fill to delivery |
| Volume (initial) | 10–100 active accounts, 50–500 trades/day |
| Volume (12-month) | 100–1,000 accounts, 500–5,000 trades/day |

### Required Event Types

| Event | Fields Required |
|-------|----------------|
| Order Fill | account_id, instrument, side (buy/sell), quantity, price, timestamp, trade_id |
| Order Cancel | account_id, order_id, timestamp |
| Position Update | account_id, instrument, current_position, unrealized_pnl |
| Account Balance | account_id, current_balance, realized_pnl |
| Daily Reset | account_id, eod_balance, eod_pnl |

### Real-Time P&L Tracking

- Per-trade realized P&L required for breach detection
- Commission and fee breakdowns required for accurate net P&L
- Daily P&L aggregation for drawdown enforcement (aligned to CME close, 5:00 PM ET)

### Daily Drawdown Tracking

- Requires start-of-day balance (reset at 5:00 PM ET / CME close)
- Maximum daily loss calculated as percentage of start-of-day balance
- Intraday monitoring preferred; end-of-day minimum

### Historical Trade Data

- Full trade history export per account (for evidence packs and dispute defense)
- Minimum 90-day retention
- Must include: trade_id, timestamps, instrument, side, qty, price, P&L, commissions

### Account Management Hooks

| Hook | Direction | Purpose |
|------|-----------|---------|
| Create Account | Meridian → Partner | Provision sim account on eval purchase |
| Disable Account | Meridian → Partner | Freeze trading on rule breach |
| Re-enable Account | Meridian → Partner | Clear breach after review |
| Delete Account | Meridian → Partner | Clean up after confirmed failure |
| Account Status | Partner → Meridian | Confirm account state changes |

### Webhook Support

- HTTPS POST with JSON payload
- HMAC-SHA256 signature header
- Retry logic with exponential backoff
- Idempotency key per event
- Anti-replay window (5-minute tolerance)

### Latency Tolerance

| Operation | Tolerance |
|-----------|-----------|
| Trade fill notification | < 30 seconds |
| Account creation | < 60 seconds |
| Account disable (breach) | < 5 seconds (critical path) |
| Daily balance snapshot | End of trading day + 15 minutes |

---

## Section 8 — Compliance Positioning

### What Meridian Is

- A **simulated trading evaluation service**
- Revenue from evaluation entry fees only
- Performance rewards funded from evaluation revenue pool
- No client deposits held
- No market access provided directly
- No broker-dealer registration required

### What Meridian Is Not

- Not a broker or broker-dealer
- Not a fund or investment vehicle
- Not holding or managing client capital
- Not providing market access (partner provides sim environment)
- Not offering financial advice

### Regulatory Terminology

The platform enforces strict language controls:

| Prohibited Term | Required Alternative |
|----------------|---------------------|
| Prop Trading | Simulated Trading Evaluation |
| Funded Account | Performance Account |
| Withdrawal | Performance Reward |
| Profit Split | Reward Split |
| Investor | Participant |
| Fund | Evaluation Program |

### Audit Trail

- Every administrative action hash-chained and tamper-evident
- Evidence packs exportable per account (trade history, violations, decisions)
- SHA-256 integrity hash on all exports
- Full reconstruction path: action → audit log → evidence pack

---

## Section 9 — Launch Strategy

### Phase 0: Private Beta (Week 0–1)

- 10–20 accounts (internal + trusted testers)
- Validate full lifecycle: purchase → trade → breach/pass → payout request
- Confirm webhook ingestion, breach detection, daily reset
- No public marketing

### Phase 1: Soft Launch (Week 2–4)

- ≤100 evaluations
- Organic acquisition only (no paid ads, no affiliates)
- Daily monitoring: pass rate, refund rate, support volume, checkout conversion
- Pause trigger: pass rate > 15% in first 50 accounts

### Phase 2: Controlled Scaling (Month 2–3)

- 200–300 evaluations/month
- Introduce targeted community marketing
- Validate: true pass rate, payout clustering patterns, support burden
- Reserve increase decision based on actual metrics

### Phase 3: Growth (Month 4+)

- Scale based on validated unit economics
- Consider Pro/Elite tier activation
- Affiliate program only after 90-day stability proof
- Reserve scaled proportionally to volume

---

## Section 10 — Open Questions for NinjaTrader

### Account Provisioning

1. What is the API or process for programmatically creating sim accounts?
2. Can account creation be triggered via webhook or REST API?
3. What is the typical provisioning latency (request to tradeable)?
4. Is there a sandbox/staging environment for integration testing?
5. Are there limits on concurrent active sim accounts per partner?

### Trade Data & Events

6. What webhook/event types are available for trade fills and order status changes?
7. What is the delivery latency for fill notifications (real-time vs batched)?
8. Do you support HMAC signature verification on outbound webhooks?
9. What is the retry policy for failed webhook deliveries?
10. Is historical trade data available via API with per-account filtering?

### Account Controls

11. Can we programmatically disable/freeze a sim account in real-time (< 5 seconds)?
12. Is there an API to reset account balances (for daily drawdown reset alignment)?
13. Can we set position size limits per account via API?
14. Is there a "read-only" mode we can toggle (trading disabled, viewing enabled)?

### P&L & Balance

15. Do you provide real-time unrealized P&L via API or websocket?
16. How is daily P&L reset handled — configurable time, or fixed to exchange close?
17. Are commissions and fees reported separately from gross P&L?
18. What is the precision of P&L reporting (decimal places)?

### Compliance & Legal

19. What is the formal relationship structure for sim evaluation partners?
20. Are there restrictions on how we describe the trading environment to participants?
21. Do you require review of our terms of service or marketing materials?
22. What jurisdictional restrictions apply to sim account provisioning?
23. Is there a compliance review process for new integration partners?

### Technical Integration

24. What authentication method is used for API access (API key, OAuth, JWT)?
25. Is there a rate limit on API calls, and what are the thresholds?
26. Do you provide a dedicated integration support contact or team?
27. What is the typical timeline from agreement to production integration?
28. Are there integration fees or per-account costs?

### Data Retention & Export

29. What is the data retention policy for trade history?
30. Can we request bulk data exports for audit or dispute defense purposes?
31. In the event of partnership termination, what is the data portability process?

---

*Document generated 2026-02-13. Meridian Prop Evaluation Platform v1.0.*  
*For questions: [contact information]*
