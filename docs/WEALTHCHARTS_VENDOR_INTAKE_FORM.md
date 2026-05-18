# WealthCharts Vendor Intake Form + 2-Call Playbook
*Updated: 2026-05-18*

This document is used during vendor calls to validate integration feasibility for **Meridian**.
Goal: get to **first real fill ingested into Meridian DB** as fast as possible.

WealthCharts is a **white-label trading platform** (similar model to Apex/Tradeify
infrastructure providers). We are not licensing market access from them — we are
running our own evaluation/risk product on top of their tenant. The conversation
is therefore equal parts technical integration AND commercial partnership terms.

---

## Call #1 — Gate Decision (15–20 minutes)

**Purpose:** Determine YES/NO quickly. If any required capability is NO, pivot immediately.

### 1) Account Provisioning (Meridian → WealthCharts)
**Ask:**
- "Can we programmatically provision sim accounts via API at any size we choose?"

**If YES, capture:**
- Returned sim account identifier field name (e.g., `accountId`, `simId`, `tenantAccountId`)
- Does it return an `external_user_id` separate from account id?
- Provision latency (request → tradeable)
- Configurable starting balance ($25k / $50k / $100k / $150k / $250k)
- Reset/refresh API (we charge traders for resets — we need the call)

### 2) Fill Delivery (WealthCharts → Meridian)
**Ask:**
- "Can you deliver fills via webhook push to our endpoint in real time?"

**If webhook, capture:**
- Signature support (HMAC-SHA256 preferred)
- Signature header names + timestamp header name (we already allow `x-wl-signature` / `x-wl-timestamp` — confirm or adjust)
- Replay window tolerance
- Unique event ID field and unique fill ID field
- Retry policy + ordering guarantee
- IP allowlist option (we will whitelist their senders)

**If polling only:**
- Endpoint pattern for fills by account + since timestamp
- Pagination + rate limits + max lookback window

### 3) Disable / Freeze (Meridian → WealthCharts)
**Ask:**
- "Can we programmatically disable/freeze a sim account in under 5 seconds?"
- "Does disable block order entry immediately (not just hide the account)?"

**Requirement:**
- Target **< 5 seconds** to take effect (our breach-enforcement SLA)
- Re-enable supported after manual review
- Status query API for reconciliation (we run a daily drift detector)

### 4) White-Label Branding
**Ask:**
- "Can the trader-facing platform be co-branded or fully branded as Meridian?"
- "Do we control the trader login flow or do you?"

**Capture:**
- Brand asset upload limits (logo, color, domain)
- Embedded vs. redirect login model
- Trader UI customization scope

---

### Gate Decision Table

| Capability | Required | Status |
|---|---:|---|
| API provisioning at our account sizes | ✅ | ☐ YES / ☐ NO |
| Fill delivery via webhook (or low-latency poll) | ✅ | ☐ YES / ☐ NO |
| Programmatic disable (< 5s) | ✅ | ☐ YES / ☐ NO |
| Reset/refresh API | ✅ | ☐ YES / ☐ NO |
| White-label branding | ✅ | ☐ YES / ☐ NO |
| Sandbox tenant within 1 week | ✅ | ☐ YES / ☐ NO |

**If any NO → pivot to NinjaTrader or alternate provider.**

---

## Call #2 — Collect Integration Artifacts (30–45 minutes)

Only proceed if Call #1 gate = **all YES**.

### Artifacts Checklist
- [ ] API docs link (or PDF) — REST + webhook spec
- [ ] Sandbox tenant credentials + key rotation process
- [ ] Sample fill payload (one real example is gold)
- [ ] Sample balance/equity payload
- [ ] Sample provisioning request/response
- [ ] Webhook signing details:
  - Algorithm (HMAC-SHA256 expected)
  - Header names (currently coded against `x-wl-signature`, `x-wl-timestamp`)
  - Signing format (`timestamp.body` vs `body` only)
  - Replay window (we default to ±300s)
- [ ] Disable endpoint details:
  - Method + path
  - What "disabled" means operationally (orders rejected? positions closed?)
  - Latency to take effect
  - Re-enable path
- [ ] Reset endpoint details + permitted frequency
- [ ] Rate limits and retry semantics
- [ ] Provisioning details:
  - Required fields (name/email/etc.)
  - Configurable properties (balance, commissions, instruments, position limits, max contracts)
  - IDs returned (`external_account_id`, `external_user_id`)
- [ ] Data retention + exports for dispute defense (90 days minimum)
- [ ] Status / health endpoint
- [ ] Webhook test / replay tool

---

## Post-Call #1 Paste Template (Send to Engineering)

Copy/paste this after the gate call:

```txt
Provisioning: YES/NO + returned account ID field name: ___
Account sizes supported: $25k / $50k / $100k / $150k / $250k → ___
Fills: webhook / polling + unique fill ID field: ___ + signing: YES/NO
Disable: YES/NO + time-to-effect: ___
Reset: YES/NO
White-label: full / co-brand / not supported
Sandbox ETA: ___
Docs link: ___
Sample payload (redacted): ___
```

Once received, engineering swaps the stub bodies in:
- `_shared/providers/wealthcharts/adapter.ts` → `provisionAccount` / `disableAccount` / `getAccountStatus`
- `_shared/brokers/wealthcharts/adapter.ts` → `verify` / `parse`

No other wiring changes — registry, lifecycle, ingest routing, UI badges, and realtime updates are already in place.

---

## 30-Second Pitch (Use on the call)

> "Meridian is the evaluation and risk engine — built, tested, and production-ready.
> We don't need market access or real capital. We need automated sim account
> provisioning, real-time fills via webhook, and a sub-5-second freeze API.
> Everything else — rule enforcement, payouts, dispute evidence, audit hash-chain,
> trader UI — is done on our side. We've already built the WealthCharts adapter
> scaffolds in code; once we have your sandbox and signing secret we can ingest
> the first real fill within 48 hours."

---

## WealthCharts Detailed Intake Form

### 1) Contact + Partnership Basics

| Field | Answer |
|---|---|
| Company / Team | WealthCharts |
| Contact name + role | |
| Email / phone / Slack | |
| Technical POC | |
| Business POC | |
| Named integration engineer for 2-week onboarding? | Y/N |
| Existing prop-firm tenants we can reference? | Y/N |
| Time to sandbox credentials | same day / 1–3 days / 1+ week |

### 2) Environment & Access

| Field | Answer |
|---|---|
| Sandbox / UAT tenant? | Y/N |
| How sandbox differs from prod | |
| Auth method | API Key / OAuth / JWT / mTLS |
| IP allowlisting required (us → them)? | Y/N |
| IP allowlist available (them → us)? | Y/N |
| Rate limits | req/min, burst |
| Separate creds per environment? | Y/N |
| Status page / incident comms channel | |

### 3) Account Provisioning (Meridian → WealthCharts)

| Field | Answer |
|---|---|
| Create sim accounts via API? | Y/N |
| Endpoint / method | |
| Required fields | |
| Typical latency (request → tradeable) | |
| Max accounts per day/week (capacity ceiling) | |
| Manual approvals needed? | Y/N |
| Starting balance configurable ($25k–$250k)? | Y/N |
| Commission model configurable? | Y/N |
| Allowed instruments configurable (CME futures)? | Y/N |
| Max contracts configurable? | Y/N |
| Session template configurable (RTH / ETH)? | Y/N |
| Reset balance via API? | Y/N |
| Reset cost to us per call? | |
| Returns external account id? | Y/N |
| Returns external user id? | Y/N |
| Other mapping keys returned | |

### 4) Trade Data Delivery (WealthCharts → Meridian)

#### Webhooks (preferred)

| Field | Answer |
|---|---|
| Webhooks for fills? | Y/N |
| Event types | fills / cancels / corrections / positions / balance / daily snapshot |
| Delivery latency (target real-time) | |
| Retry behavior (attempts, backoff) | |
| Ordering guarantees per account? | Y/N |
| Signature support | HMAC-SHA256 / JWT / other |
| Replay protection | timestamp / event id / nonce |
| Header names sent | |
| Unique event id included? | Y/N |
| Unique fill id included? | Y/N |
| Sender IPs (for allowlist) | |

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
| trade_id / fill_id (unique, idempotent) | Y/N |
| timestamp (UTC, ISO 8601) | Y/N |
| instrument symbol (CME convention) | Y/N |
| side (buy/sell) | Y/N |
| quantity | Y/N |
| price | Y/N |
| commission | Y/N |
| exchange fees | Y/N |
| realized P&L per fill | Y/N |
| net P&L (after fees) | Y/N |
| order_id (parent order linkage) | Y/N |
| liquidity flag (maker/taker) | Y/N |

If no per-fill P&L: per-trade? daily?

### 6) Symbol & Contract Metadata

| Field | Answer |
|---|---|
| Tick size feed available? | Y/N |
| Point value / contract multiplier feed? | Y/N |
| CME futures coverage (ES, NQ, MES, MNQ, CL, GC, RTY, YM, etc.) | |
| Micros supported? | Y/N |
| Equities / options / forex on roadmap? | |
| Continuous front-month symbology? | Y/N |

### 7) Balance & Daily Reset

| Field | Answer |
|---|---|
| Real-time unrealized P&L? | Y/N |
| Real-time balance/equity? | Y/N |
| Daily start-of-day equity event? | Y/N |
| Trading day definition | CME close (5pm ET) / configurable / other |
| Timezone handling | |
| End-of-day snapshot event? | Y/N |

### 8) Account Controls / Enforcement

| Field | Answer |
|---|---|
| Disable/freeze via API? | Y/N |
| Latency to take effect | target < 5s |
| Blocks order entry immediately? | Y/N |
| Auto-flatten open positions on disable? | Y/N |
| Re-enable after review? | Y/N |
| Set position limit to 0 (soft freeze)? | Y/N |
| Read-only mode toggle? | Y/N |
| Status query API (for daily reconciliation)? | Y/N |

### 9) Evidence & Dispute Defense

| Field | Answer |
|---|---|
| Historical trade export via API? | Y/N |
| Minimum retention | 90 days+ preferred |
| Per-account export format (JSON/CSV) | |
| Includes commissions/fees? | Y/N |
| Audit logs of disable/enable actions? | Y/N |
| Will WealthCharts honor subpoena/dispute requests? | Y/N |

### 10) White-Label & Trader Experience

| Field | Answer |
|---|---|
| Fully white-labeled (Meridian brand only)? | Y/N |
| Co-branded option? | Y/N |
| Custom domain support? | Y/N |
| Trader login owned by us (SSO/embed)? | Y/N |
| Custom email templates? | Y/N |
| Marketing/T&C disclosure requirements? | |
| Required exchange agreements for traders | |

### 11) Security & Compliance

| Field | Answer |
|---|---|
| SOC 2 Type II attestation? | Y/N |
| ISO 27001? | Y/N |
| Webhook secret rotation policy | |
| Encryption in transit (TLS 1.3)? | Y/N |
| Encryption at rest? | Y/N |
| PII scope crossing the boundary | |
| Data residency (US-only?) | |
| Sub-processor list available? | Y/N |

### 12) Operational SLAs

| Field | Answer |
|---|---|
| Uptime SLA (% guaranteed) | |
| Webhook delivery latency target | |
| Disable API response time SLA | |
| Incident notification protocol | |
| Maintenance window policy | |
| Breaking-change notice period | |
| Support tiers + response times | |

### 13) Simulated Environment

| Field | Answer |
|---|---|
| All accounts simulated (no live capital)? | Y/N |
| Sim data sourced from real market feed? | Y/N |
| Marketing restrictions | |
| Compliance review required before launch? | Y/N |
| Are they registered as a CME data vendor? | Y/N |

### 14) Commercial Terms

| Field | Answer |
|---|---|
| Pricing model | per-account / per-trade / rev-share / flat tenant |
| Per-account cost (and tier breaks) | |
| Per-reset cost (if separate) | |
| Minimum commitment / term length | |
| Onboarding / integration fee | |
| Revenue share / partner economics | |
| Volume discounts (50 / 200 / 500 active accounts) | |
| Termination clause + data export on exit | |
| Time-to-production estimate | |

### 15) Jurisdictional & Regulatory

| Field | Answer |
|---|---|
| Countries they serve / restrict | |
| Required trader disclosures by jurisdiction | |
| KYC requirements (if any) | |
| Tax form support (1099 generation) | Y/N |
| Conflicts with our geo-gating policy? | |

---

## Implementation Plan (Expectation Setting)

**Meridian provides:**
- Webhook endpoint + HMAC signature verification (`x-wl-signature` / `x-wl-timestamp` already supported)
- Idempotency + anti-replay
- Provider lifecycle logs (`provider_api_calls`) + tamper-evident audit hash-chain
- "Disable in < 5s" enforcement path triggered from breach detection
- Daily reconciliation against provider state (drift → staff alert)
- Trader UI with live balance, provisioning badge, breach status
- Evidence pack export for chargeback / dispute defense

**WealthCharts provides:**
- Sandbox tenant credentials within 1 week
- Named integration engineer for 2-week pilot
- Provisioning, fill webhook, disable, reset, and status endpoints
- Signed webhook secret + IP allowlist
- API docs + sample payloads + replay/test tool
- SLA terms in writing
- White-label / co-branding configuration

**Target milestones:**
- Sandbox credentials in hand: `_______`
- First test fill ingested in staging: `_______`
- First real fill ingested in prod: `_______`
- Production launch to first paying trader: `_______`

---

## Internal Notes (Remove before sending externally)

- Our adapter scaffolds are already built — `ACTIVE_PROVIDER=wealthcharts` toggles them on.
- Inbound trade routing already auto-detects WealthCharts via signature headers.
- We've done this exercise for NinjaTrader; run both vendors in parallel and pick on terms.
- If they push back on SLAs, ask for a **liability cap tied to webhook uptime** — we lose trader trust if their fills don't arrive.
- Get pricing tied to **active accounts**, not provisioned accounts — we churn through inactive ones.