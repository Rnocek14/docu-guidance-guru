import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, ExternalLink, AlertTriangle, Eye, EyeOff, Save, KeyRound } from 'lucide-react';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { MarketPositionView } from '@/components/admin/competitor-intel/MarketPositionView';
import type { SnapshotInput } from '@/lib/competitor-comparison';

// ─── Types ────────────────────────────────────────────────────────────────
type Profile = {
  firm_id: string;
  name: string;
  active: boolean;
  kind: string;
  fetch_strategy: string;
  urls: Record<string, string>;
  notes: string | null;
};

type PricingRow = {
  account_size_label?: string | null;
  list_price_usd?: number | null;
  promo_price_usd?: number | null;
  promo_label?: string | null;
  discount_pct?: number | null;
};

type Rules = {
  profit_target_usd?: number | null;
  daily_loss_usd?: number | null;
  max_drawdown_usd?: number | null;
  drawdown_type?: string | null;
  payout_split_pct?: number | null;
  first_payout_cap_usd?: number | null;
  first_payout_cap_count?: number | null;
  min_trading_days?: number | null;
  consistency_rule_pct?: number | null;
  payout_cadence_days?: number | null;
};

type Payload = {
  pricing?: PricingRow[];
  active_promo_banner?: string | null;
  promo_code?: string | null;
  rules?: Rules;
  features?: string[];
  _fetch_strategy?: string;
};

type Snapshot = {
  id: string;
  firm_id: string;
  scrape_kind: string;
  source_url: string;
  payload: Payload;
  extraction_confidence: string | null;
  captured_at: string;
};

type Change = {
  id: string;
  firm_id: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
  severity: string;
  detected_at: string;
  acknowledged: boolean;
};

// ─── Source quality ───────────────────────────────────────────────────────
type Quality = 'verified' | 'partial' | 'blocked' | 'manual';

function qualityOf(profile: Profile, latest: Snapshot | null): Quality {
  if (!latest) return 'blocked';
  const p = latest.payload ?? {};
  const hasPricing = Array.isArray(p.pricing) && p.pricing.some(
    (r) => r.list_price_usd != null || r.promo_price_usd != null,
  );
  const hasRules = p.rules && Object.values(p.rules).some((v) => v != null);
  if (hasPricing && hasRules) return 'verified';
  if (hasPricing || hasRules) return 'partial';
  return 'blocked';
}

const QUALITY_META: Record<Quality, { label: string; icon: string; className: string }> = {
  verified: { label: 'Direct verified scrape', icon: '✅', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  partial: { label: 'Partial scrape', icon: '⚠️', className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  blocked: { label: 'Blocked / manual entry', icon: '❌', className: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
  manual: { label: 'Manual profile', icon: '📝', className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n}%`;
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function CompetitorIntel() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browserlessKey, setBrowserlessKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  const profilesQ = useQuery({
    queryKey: ['ci-profiles'],
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase
        .from('competitor_intel_profiles')
        .select('firm_id, name, active, kind, fetch_strategy, urls, notes')
        .eq('active', true)
        .order('firm_id');
      if (error) throw error;
      return (data ?? []) as unknown as Profile[];
    },
  });

  const snapshotsQ = useQuery({
    queryKey: ['ci-snapshots'],
    queryFn: async (): Promise<Snapshot[]> => {
      const { data, error } = await supabase
        .from('competitor_intel_snapshots')
        .select('id, firm_id, scrape_kind, source_url, payload, extraction_confidence, captured_at')
        .order('captured_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Snapshot[];
    },
  });

  const changesQ = useQuery({
    queryKey: ['ci-changes'],
    queryFn: async (): Promise<Change[]> => {
      const { data, error } = await supabase
        .from('competitor_intel_changes')
        .select('id, firm_id, field, old_value, new_value, severity, detected_at, acknowledged')
        .order('detected_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Change[];
    },
  });

  // Default selection: first profile, prefer one with data
  const profiles = profilesQ.data ?? [];
  const snapshots = snapshotsQ.data ?? [];
  const changes = changesQ.data ?? [];

  const latestByFirm = useMemo(() => {
    const m = new Map<string, Snapshot>();
    for (const s of snapshots) if (!m.has(s.firm_id)) m.set(s.firm_id, s);
    return m;
  }, [snapshots]);

  const activeId = selectedId ?? profiles.find((p) => latestByFirm.get(p.firm_id))?.firm_id ?? profiles[0]?.firm_id ?? null;
  const activeProfile = profiles.find((p) => p.firm_id === activeId) ?? null;
  const activeSnapshot = activeId ? latestByFirm.get(activeId) ?? null : null;
  const activeChanges = useMemo(
    () => (activeId ? changes.filter((c) => c.firm_id === activeId) : []),
    [changes, activeId],
  );

  const latestSnapshotInputs: SnapshotInput[] = useMemo(() => {
    const out: SnapshotInput[] = [];
    for (const p of profiles) {
      const s = latestByFirm.get(p.firm_id);
      if (!s) continue;
      out.push({
        firm_id: p.firm_id,
        firm_name: p.name,
        captured_at: s.captured_at,
        payload: s.payload as SnapshotInput['payload'],
      });
    }
    return out;
  }, [profiles, latestByFirm]);

  // Browserless key status
  const browserlessQ = useQuery({
    queryKey: ['ci-browserless-key'],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'browserless_api_key')
        .single();
      if (error) return null;
      return (data?.value as { key?: string } | undefined)?.key ?? null;
    },
  });

  const saveBrowserlessKey = useMutation({
    mutationFn: async (key: string) => {
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key: 'browserless_api_key', value: { key } }, { onConflict: 'key' });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Browserless API key saved');
      setBrowserlessKey('');
      queryClient.invalidateQueries({ queryKey: ['ci-browserless-key'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Manual run mutation
  const runScrape = useMutation({
    mutationFn: async (firmId: string | null) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/scrape-competitor-intel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(firmId ? { kind: 'weekly', firm_id: firmId } : { kind: 'weekly' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: (body) => {
      const results = (body?.results ?? []) as Array<{ firm_id: string; status: string; changes: number; error?: string }>;
      const ok = results.filter((r) => r.status === 'ok');
      const bad = results.filter((r) => r.status !== 'ok');
      if (ok.length) toast.success(`Scraped ${ok.length} firm(s) — ${ok.reduce((a, r) => a + r.changes, 0)} change(s)`);
      for (const r of bad) toast.warning(`${r.firm_id}: ${r.error?.slice(0, 200) ?? r.status}`);
      queryClient.invalidateQueries({ queryKey: ['ci-snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['ci-changes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DashboardLayout title="Competitor Intel" navItems={missionControlNavItems}>
      <div className="space-y-4">
        <header className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Competitor Intelligence</h1>
              <p className="text-sm text-muted-foreground">
                Observational only — never feeds treasury, Monte Carlo, or pricing decisions. Source quality is labelled on every snapshot.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => runScrape.mutate(null)}
              disabled={runScrape.isPending}
            >
              {runScrape.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Run all firms</span>
            </Button>
          </div>
        </header>

        {/* Browserless API key */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4" />
              Browserless API Key
              <Badge variant="outline" className={browserlessQ.data ? 'border-emerald-500/40 text-emerald-400' : 'border-slate-500/40 text-slate-400'}>
                {browserlessQ.data ? 'Configured' : 'Not set'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKey ? 'text' : 'password'}
                  placeholder="Paste your Browserless API key…"
                  value={browserlessKey}
                  onChange={(e) => setBrowserlessKey(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                size="sm"
                onClick={() => saveBrowserlessKey.mutate(browserlessKey)}
                disabled={!browserlessKey || saveBrowserlessKey.isPending}
              >
                {saveBrowserlessKey.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                <span className="ml-2">Save</span>
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Needed for Apex, Topstep, and FTMO which sit behind Cloudflare. Stored securely in system settings.
            </p>
          </CardContent>
        </Card>

        <Tabs defaultValue="market">
          <TabsList>
            <TabsTrigger value="market">Market Position</TabsTrigger>
            <TabsTrigger value="firms">Firms (raw)</TabsTrigger>
          </TabsList>

          <TabsContent value="market" className="mt-4">
            <MarketPositionView snapshots={latestSnapshotInputs} />
          </TabsContent>

          <TabsContent value="firms" className="mt-4">
            <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          {/* Firm list */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Firms</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 p-2">
              {profilesQ.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {profiles.map((p) => {
                const snap = latestByFirm.get(p.firm_id) ?? null;
                const q = qualityOf(p, snap);
                const meta = QUALITY_META[q];
                const isActive = p.firm_id === activeId;
                return (
                  <button
                    key={p.firm_id}
                    onClick={() => setSelectedId(p.firm_id)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{p.name}</span>
                      <span title={meta.label}>{meta.icon}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {snap ? formatDistanceToNow(new Date(snap.captured_at), { addSuffix: true }) : 'no snapshot'}
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* Detail panel */}
          <div className="space-y-4">
            {!activeProfile && (
              <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Select a firm.</CardContent></Card>
            )}
            {activeProfile && (
              <FirmDetail
                profile={activeProfile}
                snapshot={activeSnapshot}
                changes={activeChanges}
                onRun={() => runScrape.mutate(activeProfile.firm_id)}
                running={runScrape.isPending}
              />
            )}
          </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}

// ─── Detail ───────────────────────────────────────────────────────────────
function FirmDetail({
  profile, snapshot, changes, onRun, running,
}: {
  profile: Profile;
  snapshot: Snapshot | null;
  changes: Change[];
  onRun: () => void;
  running: boolean;
}) {
  const quality = qualityOf(profile, snapshot);
  const meta = QUALITY_META[quality];
  const payload = snapshot?.payload ?? {};
  const pricing = payload.pricing ?? [];
  const rules = payload.rules ?? {};
  const features = payload.features ?? [];
  const sourceUrl = profile.urls?.pricing ?? profile.urls?.rules ?? profile.urls?.promo;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              {profile.name}
              <Badge variant="outline" className={meta.className}>
                <span className="mr-1">{meta.icon}</span>{meta.label}
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                {profile.fetch_strategy}
              </Badge>
              {(payload as { _fallback_used?: string })._fallback_used && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-xs">
                  fallback: {(payload as { _fallback_used?: string })._fallback_used}
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {sourceUrl && (
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {sourceUrl} <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {snapshot && (
                <span>
                  last scrape {formatDistanceToNow(new Date(snapshot.captured_at), { addSuffix: true })} •
                  confidence {snapshot.extraction_confidence ?? 'unknown'}
                </span>
              )}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onRun} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Run now</span>
          </Button>
        </CardHeader>
        {quality === 'blocked' && (
          <CardContent>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-400" />
                <div className="space-y-1">
                  <div className="font-medium text-amber-200">No verified scrape yet.</div>
                  <div className="text-amber-200/80">
                    {profile.fetch_strategy === 'firecrawl'
                      ? 'This source is Cloudflare-protected and needs Firecrawl credits. Treat as manual entry until topped up.'
                      : 'Direct fetch failed or returned no pricing/rules. Source may be JS-rendered or geo-walled. Keep as manual entry for now.'}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Promo banner */}
      {(payload.active_promo_banner || payload.promo_code) && (
        <Card>
          <CardHeader className="py-3"><CardTitle className="text-sm">Active promo</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {payload.active_promo_banner && <div className="font-medium">{payload.active_promo_banner}</div>}
            {payload.promo_code && <div className="text-xs text-muted-foreground">Code: <span className="font-mono">{payload.promo_code}</span></div>}
          </CardContent>
        </Card>
      )}

      {/* Pricing */}
      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Pricing</CardTitle></CardHeader>
        <CardContent>
          {pricing.length === 0 ? (
            <div className="text-sm text-muted-foreground">No pricing extracted.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="py-2 pr-4">Account</th><th className="py-2 pr-4">List</th><th className="py-2 pr-4">Promo</th><th className="py-2 pr-4">Discount</th><th className="py-2 pr-4">Label</th></tr>
                </thead>
                <tbody>
                  {pricing.map((r, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-2 pr-4 font-medium">{r.account_size_label ?? '—'}</td>
                      <td className="py-2 pr-4">{fmtUsd(r.list_price_usd)}</td>
                      <td className="py-2 pr-4">{fmtUsd(r.promo_price_usd)}</td>
                      <td className="py-2 pr-4">{fmtPct(r.discount_pct)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{r.promo_label ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rules */}
      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Rules</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <RuleCell label="Profit target" value={fmtUsd(rules.profit_target_usd)} />
            <RuleCell label="Daily loss" value={fmtUsd(rules.daily_loss_usd)} />
            <RuleCell label="Max drawdown" value={fmtUsd(rules.max_drawdown_usd)} />
            <RuleCell label="DD type" value={rules.drawdown_type ?? '—'} />
            <RuleCell label="Payout split" value={fmtPct(rules.payout_split_pct)} />
            <RuleCell label="First payout cap" value={fmtUsd(rules.first_payout_cap_usd)} />
            <RuleCell label="Cap count" value={rules.first_payout_cap_count?.toString() ?? '—'} />
            <RuleCell label="Min trading days" value={rules.min_trading_days?.toString() ?? '—'} />
            <RuleCell label="Consistency" value={fmtPct(rules.consistency_rule_pct)} />
            <RuleCell label="Payout cadence" value={rules.payout_cadence_days ? `${rules.payout_cadence_days}d` : '—'} />
          </div>
          {features.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {features.map((f, i) => (<Badge key={i} variant="secondary" className="font-normal">{f}</Badge>))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Change history */}
      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Change history</CardTitle></CardHeader>
        <CardContent>
          {changes.length === 0 ? (
            <div className="text-sm text-muted-foreground">No changes detected yet. First snapshot is the baseline.</div>
          ) : (
            <div className="space-y-2">
              {changes.slice(0, 20).map((c) => (
                <div key={c.id} className="flex items-start justify-between gap-3 rounded-md border border-border/50 p-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{c.field}</span>
                      <Badge variant="outline" className={
                        c.severity === 'high' ? 'border-rose-500/40 text-rose-400'
                        : c.severity === 'medium' ? 'border-amber-500/40 text-amber-400'
                        : 'border-slate-500/40 text-slate-400'
                      }>{c.severity}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="line-through opacity-70">{JSON.stringify(c.old_value)?.slice(0, 80)}</span>
                      {' → '}
                      <span>{JSON.stringify(c.new_value)?.slice(0, 80)}</span>
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(c.detected_at), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function RuleCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}