# Launch Control Checklist — Meridian v1.0

> Single-page go/no-go sheet. Every item must be ✅ before flipping `isLive: true` for production traffic.
> 
> **Last verified: 2026-03-06T18:45Z**

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
| `reserve_aware_approval` row | `system_settings` key=`reserve_aware_approval` | ✅ Present, `enabled: true`, `last_simulation_run_id` linked |
| `payment_system_state` row | `payment_system_state` (singleton) | ✅ `is_paused_inbound = false`, `is_paused_outbound = false` |
| `econ_breaker_state` row | `econ_breaker_state` (singleton) | ✅ `breaker_level = 'normal'`, no blocks active |

## 3. Simulation & Risk

| Item | How to verify | Status |
|------|---------------|--------|
| Fresh Monte Carlo simulation | `simulation_runs` table has recent row; ID matches `reserve_aware_approval.last_simulation_run_id` | ✅ Run `7e057616` on 2026-03-03, linked to reserve gate |
| Governor verdict | `governor_certifications` latest row → `verdict = 'safe'` | ✅ Latest: `safe` at 2026-03-06T17:27Z |
| Daily risk snapshot fresh | `risk_snapshots` latest row < 24h old | ✅ Latest: 2026-03-06T06:00Z (< 24h) |

## 4. Auth & Security

| Item | Where | Status |
|------|-------|--------|
| Leaked password protection | Supabase Dashboard → Auth → Settings | ⬜ **Manual verification required** |
| RLS enabled on all tables | Schema → Tables → RLS toggle | ✅ Verified in audit |
| Service role key not in frontend | Codebase search | ✅ Verified |

## 5. Stripe Checkout

| Item | How to verify | Status |
|------|---------------|--------|
| Webhook endpoint registered | Stripe Dashboard → Webhooks → endpoint URL matches `APP_ORIGIN` | ⬜ **Manual verification required** |
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
| Platform accounts mapped in `platform_accounts` | ✅ 5 seed accounts mapped (tradovate) |
| Bridge smoke test dry-run | ⚠️ Last run: FAIL (2026-03-06T18:34Z) — needs re-run with valid payload |
| Live mapped-account smoke path | ⬜ **Not yet run with real broker** |

## 8. Payment Rails

| Item | Status |
|------|--------|
| Inbound rail enabled | ✅ `stripe_cards` (inbound), `stripe_ach` (inbound+outbound) |
| Outbound rail enabled | ✅ `stripe_ach`, `bank_wire`, `wise_payouts` (all outbound-capable) |

## 9. Cron Jobs

| Item | Expected interval | Status |
|------|-------------------|--------|
| `daily-risk-snapshot` | Every 24h | ✅ Configured, enabled |
| `check-dispute-rate` | Every 1h | ✅ Configured, enabled |
| `retry-fulfillment-queue` | Every 5min | ✅ Configured, enabled |
| `evaluate-risk-throttle` | Every 6h | ✅ Configured, enabled |
| `cron-health-monitor` | Every 1h | ✅ Configured, enabled |
| `payout-sla-check` | ⬜ Not found in `cron_health_config` |
| `system-governor` | ⬜ Not found in `cron_health_config` |
| `compute-cpc` | ⬜ Not found in `cron_health_config` |

---

## Final Verdict

| Gate | Result |
|------|--------|
| All secrets present | ✅ |
| Config rows present | ✅ |
| Simulation fresh | ✅ (3 days old — acceptable) |
| Governor safe | ✅ |
| Breaker normal | ✅ |
| Bridge dry-run passed | ⚠️ Last run FAIL — needs re-run |
| Live smoke passed | ⬜ Not yet |
| Leaked password protection | ⬜ Manual check needed |
| Stripe webhook verified | ⬜ Manual check needed |
| All cron jobs registered | ⚠️ 3 missing from `cron_health_config` |

**Overall: 🟡 GO WITH GUARDRAILS — clear 4 manual items + fix bridge dry-run + register missing crons**

---

## Remaining Items to Clear

1. **Leaked password protection** — Enable in Supabase Dashboard → Auth → Settings
2. **Stripe webhook** — Verify endpoint URL, subscribed events, and run one test checkout
3. **Bridge smoke test** — Re-run `bridge-smoke-test` dry-run with valid Tradovate payload shape
4. **Live smoke path** — Run one `bridge-smoke-test` in `live` mode against a mapped account
5. **Missing cron configs** — Add `payout-sla-check`, `system-governor`, `compute-cpc` to `cron_health_config`

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

*Verified: 2026-03-06 · Audit version: v1.0 · Rules version: v1.0*
