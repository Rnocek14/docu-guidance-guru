# Launch Control Checklist — Meridian v1.0

> Single-page go/no-go sheet. Every item must be ✅ before flipping `isLive: true` for production traffic.
>
> **Last verified: 2026-03-06T20:10Z (live DB queries)**

## 1. Secrets & Environment

| Item | Where to verify | Status |
|------|----------------|--------|
| `STRIPE_SECRET_KEY` | Edge Functions → Secrets | ✅ Present |
| `STRIPE_WEBHOOK_SECRET` | Edge Functions → Secrets | ✅ Present |
| `APP_ORIGIN` | Edge Functions → Secrets | ✅ Present |
| `CRON_SECRET` | Edge Functions → Secrets | ✅ Present |
| `TRADE_WEBHOOK_SECRET` | Edge Functions → Secrets | ✅ Present |
| `QA_SECRET` | Edge Functions → Secrets | ✅ Present |
| `RESEND_API_KEY` | Edge Functions → Secrets | ✅ Present |
| `OPENAI_API_KEY` | Edge Functions → Secrets | ✅ Present |

## 2. Required Config Rows

| Item | Table / Key | Status |
|------|-------------|--------|
| `reserve_aware_approval` row | `system_settings` key=`reserve_aware_approval` | ✅ Present, `enabled: true`, `last_simulation_run_id: 7e057616` |
| `payment_system_state` row | `payment_system_state` (singleton) | ✅ `is_paused_inbound = false`, `is_paused_outbound = false` |
| `econ_breaker_state` row | `econ_breaker_state` (singleton) | ✅ `breaker_level = 'normal'`, no blocks active |

## 3. Simulation & Risk

| Item | How to verify | Status |
|------|---------------|--------|
| Fresh Monte Carlo simulation | `simulation_runs` ID matches `reserve_aware_approval.last_simulation_run_id` | ✅ Run `7e057616` on 2026-03-03 |
| Governor verdict | `governor_certifications` latest row → `verdict` | ✅ `safe` at 2026-03-06T17:27Z |
| Daily risk snapshot fresh | `risk_snapshots` latest row < 24h old | ✅ 2026-03-06T06:00Z |

## 4. Auth & Security

| Item | Where | Status |
|------|-------|--------|
| Leaked password protection | Supabase Dashboard → Auth → Settings | ⬜ **Manual verification required** |
| RLS enabled on all tables | Schema → Tables → RLS toggle | ✅ Verified in audit |
| Service role key not in frontend | Codebase search | ✅ Verified |

## 5. Stripe Checkout

| Item | How to verify | Status |
|------|---------------|--------|
| Webhook endpoint registered | Stripe Dashboard → Webhooks | ⬜ **Manual verification required** |
| Events subscribed | `checkout.session.completed`, `charge.refunded` | ⬜ **Manual verification required** |
| Test purchase completes | Manual Stripe test mode checkout | ⬜ **Manual verification required** |

## 6. Tier Economics Alignment

| Item | Canonical value | Status |
|------|----------------|--------|
| Split percent | 80% (base) | ✅ `tier-economics.ts` ↔ DB cohorts |
| First payout cap | $500 | ✅ Aligned |
| Lifetime cap multiple | 10× | ✅ Aligned |
| Cooldown days | 14 | ✅ Aligned |
| Entry fee (Starter) | $149 | ✅ Aligned |

## 7. Bridge & Broker

| Item | Status |
|------|--------|
| Platform accounts mapped | ✅ 5 seed accounts mapped (tradovate) |
| Tradovate adapter unit tests | ✅ 15/15 pass (verify, parse, symbol normalization) |
| Bridge smoke test dry-run | ⚠️ Adapter logic verified via unit tests; deployed endpoint requires CRON_SECRET auth (cannot be tested via automated tooling) |
| Live mapped-account smoke path | ⬜ **Requires real broker account — manual execution** |

## 8. Payment Rails

| Item | Status |
|------|--------|
| Inbound rail enabled | ✅ `stripe_cards` (inbound), `stripe_ach` (in+out) |
| Outbound rail enabled | ✅ `stripe_ach`, `bank_wire`, `wise_payouts` |

## 9. Cron Jobs

| Item | Expected interval | Status |
|------|-------------------|--------|
| `daily-risk-snapshot` | Every 24h | ✅ Configured, enabled |
| `check-dispute-rate` | Every 1h | ✅ Configured, enabled |
| `retry-fulfillment-queue` | Every 5min | ✅ Configured, enabled |
| `evaluate-risk-throttle` | Every 6h | ✅ Configured, enabled |
| `cron-health-monitor` | Every 1h | ✅ Configured, enabled |
| `payout-sla-check` | Every 1h | ✅ Configured, enabled |
| `system-governor` | Every 1h | ✅ Configured, enabled |
| `compute-cpc` | Every 6h | ✅ Configured, enabled |

---

## Final Verdict

| Gate | Result |
|------|--------|
| All secrets present | ✅ 8/8 |
| Config rows present | ✅ 3/3 |
| Simulation linked | ✅ |
| Governor safe | ✅ |
| Breaker normal | ✅ |
| Payment rails active | ✅ 4 rails |
| Adapter unit tests | ✅ 15/15 |
| Cron jobs registered | ✅ 8/8 |
| Leaked password protection | ⬜ Manual check |
| Stripe webhook verified | ⬜ Manual check |
| Live broker smoke path | ⬜ Manual — requires real broker |

**Overall: 🟡 GO WITH GUARDRAILS — 3 manual-only items remain (all require external dashboard access)**

---

## Items Requiring Manual Verification

These cannot be verified programmatically and require dashboard/console access:

1. **Leaked password protection** — Supabase Dashboard → Auth → Settings → Enable
2. **Stripe webhook endpoint** — Stripe Dashboard → Webhooks → Verify endpoint URL + subscribed events → Run one test checkout
3. **Live broker smoke path** — Run `bridge-smoke-test` with `x-cron-secret` header against a real mapped broker account

---

## Day 0 Watchlist

Monitor these continuously for the first 24 hours after go-live:

| Signal | Where to check | Red threshold |
|--------|---------------|---------------|
| Fulfillment queue stuck rows | `checkout_fulfillment_queue` WHERE `status = 'queued' AND attempts > 2` | Any row > 15min old |
| Unknown broker account quarantines | `broker_payload_samples` with no matching `platform_accounts` row | Any new row |
| Payout approval failures | `audit_logs` WHERE `action = 'payout_rejected'` | Unexpected rejections |
| Dispute rate alerts | `check-dispute-rate` logs / `chargeback_events` | Rate ≥ 0.20% |
| Breaker level changes | `econ_breaker_state.breaker_level` | Any value ≠ `normal` |
| Edge function timeout spikes | Supabase Dashboard → Edge Functions → Logs | Any 504 or execution > 25s |
| Governor verdict drift | `governor_certifications` latest row | `verdict ≠ 'safe'` |
| Reconciliation failures | `audit_logs` WHERE `action = 'reconciliation_failed'` | Any in last 6h |
| Payment rail disablement | `payment_rails` WHERE `is_enabled = false` | Unexpected disable |
| Risk snapshot staleness | `risk_snapshots` latest `created_at` | > 26h old |

### Escalation protocol

1. **Breaker trips** → Check `econ_breaker_state`, review cause, follow Ops Playbook crisis order (lock inbound → outbound → intake)
2. **Fulfillment stuck** → Check `retry-fulfillment-queue` logs, verify breaker isn't blocking, manually retry if needed
3. **Dispute spike** → Review `chargeback_events`, check for fraud pattern, consider pausing riskier traffic
4. **Governor NO-GO** → Do NOT override; investigate which domain failed, remediate via Mission Control

---

*Verified against live database: 2026-03-06T20:10Z · Audit version: v1.0 · Rules version: v1.0*
