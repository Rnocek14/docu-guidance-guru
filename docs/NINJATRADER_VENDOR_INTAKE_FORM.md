# NinjaTrader Vendor Intake Form + 2-Call Playbook
*Updated: 2026-02-16*

This document is used during vendor calls to validate integration feasibility for **Meridian**.
Goal: get to **first real fill ingested into Meridian DB** as fast as possible.

---

## Call #1 — Gate Decision (15–20 minutes)

**Purpose:** Determine YES/NO quickly. If any required capability is NO, pivot immediately.

### 1) Account Provisioning (Meridian → Provider)
**Ask:**
- "Can you programmatically provision sim accounts via API?"

**If YES, capture:**
- Returned sim account identifier field name (e.g., `accountId`, `simId`, `externalId`)
- Does it return an `external_user_id` separate from account id?
- Provision latency (request → tradeable)

### 2) Fill Delivery (Provider → Meridian)
**Ask:**
- "Can you deliver fills — via webhook push or API polling?"

**If webhook, capture:**
- Signature support (HMAC/JWT/other)
- Signature header names + timestamp header name
- Replay window tolerance
- Unique event ID field and unique fill ID field
- Retry policy + ordering guarantee

**If polling, capture:**
- Endpoint pattern for fills by account + since timestamp
- Pagination format
- Rate limits
- Max lookback window

### 3) Disable / Freeze (Meridian → Provider)
**Ask:**
- "Can you programmatically disable/freeze a sim account quickly?"
- "Does disable block order entry immediately?"

**Requirement:**
- Target < 5 seconds to take effect
- Re-enable supported after manual review (preferred)

---

### Gate Decision Table

| Capability | Required | Status |
|---|---:|---|
| API provisioning | ✅ | ☐ YES / ☐ NO |
| Fill delivery (webhook or poll) | ✅ | ☐ YES / ☐ NO |
| Programmatic disable (< 5s) | ✅ | ☐ YES / ☐ NO |

**If any NO → pivot to another provider.**

---

## Call #2 — Collect Integration Artifacts (30–45 minutes)

Only proceed if Call #1 gate = **all YES**.

### Artifacts Checklist
- [ ] API docs link (or PDF)
- [ ] Sandbox credentials + rotation process
- [ ] Sample fill payload (one real example is gold)
- [ ] Sample balance/equity payload
- [ ] Webhook signing details:
  - Algorithm (HMAC-SHA256?)
  - Header names (`X-Signature`, `X-Timestamp`, etc.)
  - Signing format (`timestamp.body` vs `body` only)
  - Replay window
- [ ] Disable endpoint details:
  - Method + path
  - What "disabled" means operationally
  - Latency to take effect
  - Re-enable path
- [ ] Rate limits and retry semantics
- [ ] Provisioning details:
  - Required fields (name/email/etc.)
  - Configurable properties (balance, commissions, instruments, position limits)
  - IDs returned (`external_account_id`, `external_user_id`)
- [ ] Data retention + exports:
  - Per-account historical fill export availability
  - Retention duration
  - Includes fees/commissions

---

## Post-Call #1 Paste Template (Send to Engineering)

Copy/paste this after the gate call:

```txt
Provisioning: YES/NO + returned account ID field name: ___
Fills: webhook / polling + unique fill ID field: ___ + signing: YES/NO
Disable: YES/NO + time-to-effect: ___
Docs link: ___
Sample payload (redacted): ___
```

Once received, engineering maps directly into:
- `ProviderAdapter.provisionAccount()`
- `ProviderAdapter.disableAccount()`
- `ProviderAdapter.getAccountStatus()` (optional)
- `BrokerAdapter.verify()`/`parse()` for fill schema ingestion

---

## 30-Second Pitch (Use on the call)

> "Meridian is the evaluation and risk engine. We don't need market access or real capital — we only need automated sim account provisioning, real-time fills, and a way to freeze accounts on breach. Everything else is handled on our side, with full audit logging and dispute-proof evidence packs."

---

## NinjaTrader Detailed Intake Form

### 1) Contact + Partnership Basics

| Field | Answer |
|---|---|
| Company / Team | |
| Contact name + role | |
| Email / phone / Slack | |
| Technical POC | |
| Business POC | |
| Support eval/partner programs today? | Y/N |
| Time to sandbox credentials | same day / 1–3 days / 1+ week |

### 2) Environment & Access

| Field | Answer |
|---|---|
| Sandbox / UAT environment? | Y/N |
| How sandbox differs from prod | |
| Auth method | API Key / OAuth / JWT / other |
| IP allowlisting required? | Y/N |
| Rate limits | req/min, burst |
| Separate creds per environment? | Y/N |

### 3) Account Provisioning (Meridian → Provider)

| Field | Answer |
|---|---|
| Create sim accounts via API? | Y/N |
| Endpoint / method | |
| Required fields | |
| Typical latency | |
| Max accounts per day/week | |
| Manual approvals needed? | Y/N |
| Starting balance configurable? | Y/N |
| Commission model configurable? | Y/N |
| Allowed instruments configurable? | Y/N |
| Max contracts configurable? | Y/N |
| Session template configurable? | Y/N |
| Reset balance via API? | Y/N |
| Returns external account id? | Y/N |
| Returns external user id? | Y/N |
| Other mapping keys | |

### 4) Trade Data Delivery (Provider → Meridian)

#### Webhooks

| Field | Answer |
|---|---|
| Webhooks for fills? | Y/N |
| Event types | fills / cancels / positions / balance / daily |
| Delivery latency | real-time / seconds / batched |
| Retry behavior | |
| Ordering guarantees? | Y/N |
| Signature support | HMAC / JWT / other |
| Replay protection | timestamp / event id / nonce |
| Headers sent | |
| Unique event id included? | Y/N |
| Unique fill id included? | Y/N |

#### Polling fallback

| Field | Answer |
|---|---|
| API for recent fills by account? | Y/N |
| Max lookback window | |
| Pagination format | |
| Rate limits | |
| Query by since timestamp? | Y/N |

### 5) Required Fill Schema

| Field | Available? |
|---|---|
| account_id | Y/N |
| trade_id / fill_id | Y/N |
| timestamp (UTC) | Y/N |
| instrument symbol | Y/N |
| side (buy/sell) | Y/N |
| quantity | Y/N |
| price | Y/N |
| commission | Y/N |
| fees | Y/N |
| realized P&L per fill | Y/N |
| net P&L (after fees) | Y/N |

If no per-fill P&L: per-trade? daily?

### 6) Balance & Daily Reset

| Field | Answer |
|---|---|
| Real-time unrealized P&L? | Y/N |
| Real-time balance/equity? | Y/N |
| Daily start-of-day equity? | Y/N |
| Trading day definition | exchange close / configurable / timezone |
| End-of-day snapshot event? | Y/N |

### 7) Account Controls / Enforcement

| Field | Answer |
|---|---|
| Disable/freeze via API? | Y/N |
| Latency to take effect | target < 5s |
| Blocks order entry immediately? | Y/N |
| Re-enable after review? | Y/N |
| Set position limit to 0? | Y/N |
| Read-only mode toggle? | Y/N |

### 8) Evidence & Dispute Defense

| Field | Answer |
|---|---|
| Historical trade export via API? | Y/N |
| Minimum retention | 90 days+ preferred |
| Per-account export? | Y/N |
| Includes commissions/fees? | Y/N |
| Audit logs of disable actions? | Y/N |

### 9) Simulated Environment

| Field | Answer |
|---|---|
| All accounts simulated? | Y/N |
| Marketing restrictions? | |
| Compliance review required? | Y/N |

### 10) Commercial Terms

| Field | Answer |
|---|---|
| Per-account cost | |
| Minimum commitments | |
| Revenue share / partner fees | |
| Support package | Y/N |
| Integration fees | |
| Time-to-production estimate | |

---

## Implementation Plan (Expectation Setting)

**We provide:**
- Webhook endpoint + signature verification
- Idempotency + replay protection
- Provider lifecycle logs + evidence packs
- "Disable in < 5s" enforcement path

**They provide:**
- Sandbox credentials
- Provisioning method
- Event delivery method (webhook or polling)
- Disable method
- Schema docs + sample payloads

**Target milestone:** First real fill ingested by: `_______`
