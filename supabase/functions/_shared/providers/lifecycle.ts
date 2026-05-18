// Provider lifecycle operations with logging + error handling.
// Wraps raw adapter calls with DB logging to provider_api_calls.

import type { ProviderAdapter } from './adapter.ts';
import type { ProvisionRequest, ProvisionResult, DisableRequest, DisableResult, AccountStatusResult } from './types.ts';

interface LifecycleContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  requestId: string;
}

async function logApiCall(
  ctx: LifecycleContext,
  adapter: ProviderAdapter,
  action: string,
  accountId: string | null,
  externalAccountId: string | null,
  requestPayload: Record<string, unknown>,
  fn: () => Promise<{ ok: boolean; error?: string; httpStatus?: number; latencyMs?: number; [key: string]: unknown }>
) {
  const start = performance.now();
  let result: Awaited<ReturnType<typeof fn>>;
  let latencyMs: number;

  try {
    result = await fn();
    latencyMs = result.latencyMs ?? Math.round(performance.now() - start);
  } catch (err) {
    latencyMs = Math.round(performance.now() - start);
    result = { ok: false, error: (err as Error).message, httpStatus: 0, latencyMs };
  }

  // Log to provider_api_calls (best-effort)
  await ctx.supabase.from('provider_api_calls').insert({
    provider: adapter.id,
    action,
    account_id: accountId,
    external_account_id: externalAccountId,
    request_payload: requestPayload,
    response_payload: result,
    http_status: result.httpStatus ?? null,
    success: result.ok,
    error: result.error ?? null,
    latency_ms: latencyMs,
  }).catch(() => { /* best-effort logging */ });

  return result;
}

/**
 * Provision a sim account with full logging.
 */
export async function provisionAccount(
  ctx: LifecycleContext,
  adapter: ProviderAdapter,
  req: ProvisionRequest
): Promise<ProvisionResult> {
  const result = await logApiCall(
    ctx, adapter, 'provision', req.accountId, null,
    { startingBalance: req.startingBalance, tierLabel: req.tierLabel },
    () => adapter.provisionAccount(req)
  ) as ProvisionResult;

  // If successful, update the accounts row with provider info
  if (result.ok && result.externalAccountId) {
    await ctx.supabase.from('accounts').update({
      external_provider: adapter.id,
      external_account_id: result.externalAccountId,
      external_user_id: result.externalUserId ?? null,
      external_status: 'active',
      provisioned_at: new Date().toISOString(),
      provider_metadata: result.providerMetadata ?? {},
    }).eq('id', req.accountId).catch(() => {});

    // Also create platform_accounts mapping for trade ingestion.
    // Unique constraint in DB is (platform_account_id, platform_name) — the
    // onConflict target MUST match an existing unique index or the upsert
    // throws. Using ignoreDuplicates so re-provisions (rare, but possible on
    // retry) are a no-op rather than an error.
    await ctx.supabase.from('platform_accounts').upsert({
      account_id: req.accountId,
      platform_name: adapter.id,
      platform_account_id: result.externalAccountId,
    }, { onConflict: 'platform_account_id,platform_name', ignoreDuplicates: true }).catch(() => {});
  }

  return result;
}

/**
 * Disable a sim account with full logging.
 * Must be fast (<5s) for breach enforcement.
 */
export async function disableAccount(
  ctx: LifecycleContext,
  adapter: ProviderAdapter,
  req: DisableRequest
): Promise<DisableResult> {
  const result = await logApiCall(
    ctx, adapter, 'disable', req.accountId, req.externalAccountId,
    { reason: req.reason, breachType: req.breachType },
    () => adapter.disableAccount(req)
  ) as DisableResult;

  // Update account with disable status
  if (result.ok && result.confirmed) {
    await ctx.supabase.from('accounts').update({
      external_status: 'disabled',
      disabled_at: new Date().toISOString(),
    }).eq('id', req.accountId).catch(() => {});
  } else if (!result.ok) {
    // Critical: disable failed — alert staff
    await ctx.supabase.from('staff_notifications').insert({
      notification_type: 'provider_disable_failed',
      title: '🚨 Provider account disable failed',
      body: `Failed to disable account ${req.accountId} (ext: ${req.externalAccountId}) at provider ${adapter.id}. Reason: ${req.reason}. Error: ${result.error}. MANUAL ACTION REQUIRED.`,
      data: { account_id: req.accountId, external_account_id: req.externalAccountId, provider: adapter.id, error: result.error },
      idempotency_key: `provider_disable_failed:${req.accountId}:${ctx.requestId}`,
    }).catch(() => {});
  }

  return result;
}

/**
 * Query account status from provider (optional, for reconciliation).
 */
export async function getAccountStatus(
  ctx: LifecycleContext,
  adapter: ProviderAdapter,
  accountId: string,
  externalAccountId: string
): Promise<AccountStatusResult> {
  if (!adapter.getAccountStatus) {
    return { ok: false, error: 'Provider does not support status queries' };
  }

  return await logApiCall(
    ctx, adapter, 'status', accountId, externalAccountId,
    {},
    () => adapter.getAccountStatus!(externalAccountId)
  ) as AccountStatusResult;
}
