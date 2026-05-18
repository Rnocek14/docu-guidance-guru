---
name: Provider Adapter Wiring
description: ACTIVE_PROVIDER env var controls broker lifecycle calls (provision/disable/reconcile). Stub adapters return not_implemented loudly.
type: feature
---
# Provider Adapter Wiring

The platform calls the active broker/provider at three points:

1. **Provisioning** — `stripe-webhook/checkout-handler.ts` calls `provisionAccount` after `fulfill_checkout_session` succeeds. Non-blocking to checkout; failure → `staff_notifications` (`provider_provision_failed`).
2. **Disable on breach** — `review-actions/index.ts` calls `disableAccount` after `confirm_failure` flips status to `failed_confirmed`. Only fires when `accounts.external_account_id` is set.
3. **Daily reconciliation** — `daily-risk-snapshot/index.ts` calls `getAccountStatus` for up to 200 accounts per run. Drift → `staff_notifications` (`provider_state_drift`) + `PROVIDER_STATE_DRIFT` alarm.

## Active provider selection
- Controlled by `ACTIVE_PROVIDER` edge function env var (e.g. `wealthcharts`).
- Empty / unset → all three call sites no-op cleanly (system runs as today).
- Helper: `getActiveProvider()` in `_shared/providers/adapter.ts`.

## Adding a new provider
1. Implement `ProviderAdapter` at `_shared/providers/<vendor>/adapter.ts`.
2. Register via `registerProvider('<vendor>', loader)` in `_shared/providers/adapter.ts`.
3. Set `ACTIVE_PROVIDER=<vendor>` secret. No call-site changes needed.

## Stub policy
WealthCharts stub returns `not_implemented` (HTTP 501) so the lifecycle wrapper raises loud staff alerts if `ACTIVE_PROVIDER=wealthcharts` is enabled before the real adapter ships.
