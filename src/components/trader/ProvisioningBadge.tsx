import { Loader2, AlertTriangle } from 'lucide-react';

interface MinAccount {
  external_provider?: string | null;
  external_account_id?: string | null;
  external_status?: string | null;
  provisioned_at?: string | null;
  created_at?: string;
}

/**
 * Surfaces broker-side provisioning state to the trader so an account is
 * never silently shown as "active" when no sim exists at the provider.
 *
 * Only renders when an active provider is configured for this account
 * (`external_provider` is set on the row by `provisionAccount`). If
 * `external_provider` is null, the platform isn't routing to a vendor yet
 * and this badge stays invisible.
 *
 * States:
 *   - external_status='active'      → no badge (happy path)
 *   - external_status null/pending  → "Provisioning…" (spinner)
 *   - external_status='disabled'    → "Broker disabled" (warning)
 *   - anything else                 → raw status (warning)
 */
export function ProvisioningBadge({ account }: { account: MinAccount }) {
  if (!account.external_provider) return null;

  const status = account.external_status;

  if (status === 'active') return null;

  if (!status || status === 'pending') {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Provisioning at broker — trading enables shortly.</span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>
        Broker status: <strong className="font-semibold">{status}</strong>. Contact support if this persists.
      </span>
    </div>
  );
}