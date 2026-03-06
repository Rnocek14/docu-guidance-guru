# Launch Control Checklist — Meridian v1.0

> Single-page go/no-go sheet. Every item must be ✅ before flipping `isLive: true` for production traffic.

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
| `reserve_aware_approval` row | `system_settings` key=`reserve_aware_approval` | ⬜ Insert with `{ "enabled": true, "last_simulation_run_id": "<uuid>" }` |
| `payment_system_state` row | `payment_system_state` (singleton) | ⬜ Verify `is_paused_inbound = false` |
| `econ_breaker_state` row | `econ_breaker_state` (singleton) | ⬜ Verify `breaker_level = 'normal'` |

## 3. Simulation & Risk

| Item | How to verify | Status |
|------|---------------|--------|
| Fresh Monte Carlo simulation | `simulation_runs` table has recent row; ID matches `reserve_aware_approval.last_simulation_run_id` | ⬜ Run via admin dashboard |
| Governor verdict | `governor_certifications` latest row → `verdict = 'GO'` | ⬜ Run `system-governor` |
| Daily risk snapshot fresh | `risk_snapshots` latest row < 24h old | ⬜ Trigger `daily-risk-snapshot` |

## 4. Auth & Security

| Item | Where | Status |
|------|-------|--------|
| Leaked password protection | Supabase Dashboard → Auth → Settings | ⬜ Enable manually |
| RLS enabled on all tables | Schema → Tables → RLS toggle | ✅ Verified in audit |
| Service role key not in frontend | Codebase search | ✅ Verified |

## 5. Stripe Checkout

| Item | How to verify | Status |
|------|---------------|--------|
| Webhook endpoint registered | Stripe Dashboard → Webhooks → endpoint URL matches `APP_ORIGIN` | ⬜ Verify |
| Events subscribed | `checkout.session.completed`, `charge.refunded` | ⬜ Verify |
| Test purchase completes | Manual Stripe test mode checkout | ⬜ Run once |

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
| First broker account mapped in `platform_accounts` | ⬜ Pending |
| Bridge smoke test dry-run passed | ⬜ Run `bridge-smoke-test` |
| Live mapped-account smoke path | ⬜ Run once with real broker |

## 8. Payment Rails

| Item | Status |
|------|--------|
| At least one inbound rail enabled | ⬜ Verify `payment_rails` table |
| At least one outbound rail enabled | ⬜ Verify `payment_rails` table |

## 9. Cron Jobs

| Item | Expected interval | Status |
|------|-------------------|--------|
| `daily-risk-snapshot` | Every 24h | ⬜ Verify `pg_cron` |
| `check-dispute-rate` | Every 6h | ⬜ Verify `pg_cron` |
| `retry-fulfillment-queue` | Every 5min | ⬜ Verify `pg_cron` |
| `payout-sla-check` | Every 1h | ⬜ Verify `pg_cron` |
| `system-governor` | Every 1h | ⬜ Verify `pg_cron` |
| `compute-cpc` | Every 6h | ⬜ Verify `pg_cron` |

---

## Final Verdict

| Gate | Result |
|------|--------|
| All secrets present | ✅ |
| Config rows present | ⬜ |
| Simulation fresh | ⬜ |
| Governor GO | ⬜ |
| Breaker normal | ⬜ |
| Bridge dry-run passed | ⬜ |
| Live smoke passed | ⬜ |
| Leaked password protection | ⬜ |

**Overall: ⬜ NOT YET — clear remaining items above**

---

*Generated: 2026-03-06 · Audit version: v1.0 · Rules version: v1.0*
