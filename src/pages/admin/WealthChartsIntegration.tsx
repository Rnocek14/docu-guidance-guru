import { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Copy, Check, ExternalLink, KeyRound, Webhook, Link2, FileJson, ShieldCheck, AlertTriangle, BookOpen, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';

// Derive project ref from the canonical functions URL (no hardcoded project ID).
// SUPABASE_FUNCTIONS_URL is `https://<ref>.supabase.co/functions/v1`.
const PROJECT_REF = (() => {
  try {
    const host = new URL(SUPABASE_FUNCTIONS_URL).host; // <ref>.supabase.co
    return host.split('.')[0];
  } catch {
    return '';
  }
})();

const STORAGE_KEY = 'meridian.wealthcharts.intake.v1';

type IntakeForm = {
  // Environment
  sandboxBaseUrl: string;
  prodBaseUrl: string;
  // Auth
  apiKeyId: string;
  apiKeyRotationPolicy: string;
  // Webhook
  webhookAlgorithm: string;
  signatureHeader: string;
  timestampHeader: string;
  signingFormat: string;
  replayWindowSeconds: string;
  sourceIps: string;
  // Payload field names
  accountIdField: string;
  externalUserIdField: string;
  fillIdField: string;
  eventIdField: string;
  // Provisioning
  provisionEndpoint: string;
  supportedAccountSizes: string;
  provisionLatencyMs: string;
  // Disable
  disableEndpoint: string;
  disableLatencyMs: string;
  // Reset
  resetEndpoint: string;
  // Reconciliation
  statusEndpoint: string;
  fillsLookbackEndpoint: string;
  // Notes
  samplePayload: string;
  notes: string;
};

const DEFAULT_FORM: IntakeForm = {
  sandboxBaseUrl: '',
  prodBaseUrl: '',
  apiKeyId: '',
  apiKeyRotationPolicy: '',
  webhookAlgorithm: 'HMAC-SHA256',
  signatureHeader: 'x-wl-signature',
  timestampHeader: 'x-wl-timestamp',
  signingFormat: 'timestamp.body',
  replayWindowSeconds: '300',
  sourceIps: '',
  accountIdField: '',
  externalUserIdField: '',
  fillIdField: '',
  eventIdField: '',
  provisionEndpoint: '',
  supportedAccountSizes: '',
  provisionLatencyMs: '',
  disableEndpoint: '',
  disableLatencyMs: '',
  resetEndpoint: '',
  statusEndpoint: '',
  fillsLookbackEndpoint: '',
  samplePayload: '',
  notes: '',
};

function loadForm(): IntakeForm {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FORM;
    return { ...DEFAULT_FORM, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FORM;
  }
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success(`${label ?? 'Value'} copied`);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function OutputRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
        <CopyButton value={value} label={label} />
      </div>
      <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">{value}</code>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function FieldRow({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  required,
  multiline,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-sm">
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        {value && <Badge variant="outline" className="text-[10px]">captured</Badge>}
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={6}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function WealthChartsIntegration() {
  const [form, setForm] = useState<IntakeForm>(loadForm);

  const update = <K extends keyof IntakeForm>(k: K, v: IntakeForm[K]) => {
    const next = { ...form, [k]: v };
    setForm(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(form, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wealthcharts-intake-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Intake exported');
  };

  const reset = () => {
    if (!confirm('Clear all captured values?')) return;
    setForm(DEFAULT_FORM);
    localStorage.removeItem(STORAGE_KEY);
    toast.success('Cleared');
  };

  // Outputs computed from project
  const ingestWebhookUrl = `${SUPABASE_URL}/functions/v1/ingest-trade`;
  const smokeTestUrl = `${SUPABASE_URL}/functions/v1/bridge-smoke-test`;
  const successRedirect = `${window.location.origin}/dashboard`;
  const supabaseSecretsUrl = `https://supabase.com/dashboard/project/${PROJECT_REF}/settings/functions`;

  const requiredFields: (keyof IntakeForm)[] = [
    'sandboxBaseUrl',
    'apiKeyId',
    'webhookAlgorithm',
    'signatureHeader',
    'timestampHeader',
    'accountIdField',
    'fillIdField',
    'provisionEndpoint',
    'disableEndpoint',
    'samplePayload',
  ];
  const filledRequired = requiredFields.filter((k) => (form[k] ?? '').trim().length > 0).length;
  const pct = Math.round((filledRequired / requiredFields.length) * 100);

  return (
    <DashboardLayout title="WealthCharts Integration" navItems={missionControlNavItems}>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">WealthCharts Integration Workbook</h2>
            <p className="text-muted-foreground">
              One page to collect everything from WealthCharts and hand back what they need from us.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={reset}>Clear</Button>
            <Button onClick={exportJson}>Export JSON</Button>
          </div>
        </div>

        {/* Plain-English overview */}
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4" /> Start here — what this page is for
            </CardTitle>
            <CardDescription>
              Read this once. It explains the whole integration in plain English.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p>
              <strong>Meridian</strong> (this app) needs to talk to <strong>WealthCharts</strong>{' '}
              (the trading platform that hosts the sim accounts your traders use). Two things
              have to happen:
            </p>
            <ol className="ml-5 list-decimal space-y-1.5">
              <li>
                <strong>They send us trades.</strong> Every time a trader places a fill,
                WealthCharts pushes a webhook to our <code>ingest-trade</code> URL so we can
                score the account, enforce drawdown, and gate payouts.
              </li>
              <li>
                <strong>We send them commands.</strong> When a trader buys an account, passes,
                or breaches a rule, we call WealthCharts to provision, reset, or freeze the
                sim account.
              </li>
            </ol>
            <p>
              To wire those two flows up, we need a handful of values from WealthCharts (URLs,
              header names, an API key) and we need to hand back a few URLs to them. This page
              collects all of that in one place.
            </p>
            <div className="grid gap-2 pt-2 md:grid-cols-3">
              <div className="rounded-md border bg-background p-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <KeyRound className="h-3.5 w-3.5" /> Inputs
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  What you collect FROM WealthCharts on your onboarding call.
                </p>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Webhook className="h-3.5 w-3.5" /> Outputs
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  What you hand BACK to WealthCharts (URLs, signature scheme).
                </p>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <ShieldCheck className="h-3.5 w-3.5" /> Secrets & Go-Live
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Where the API key + webhook secret go, and the launch checklist.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span>
                <strong>Suggested order:</strong> Inputs tab during the WealthCharts call{' '}
                <ArrowRight className="inline h-3 w-3" /> Outputs tab to email them back{' '}
                <ArrowRight className="inline h-3 w-3" /> Secrets tab to flip the switch.
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Progress */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Vendor intake progress</span>
              <Badge variant={pct === 100 ? 'default' : 'secondary'}>
                {filledRequired}/{requiredFields.length} required
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Once all required fields are captured + secrets added in Supabase, the WealthCharts
              adapter stubs can be replaced with real implementations.
            </p>
          </CardContent>
        </Card>

        <Tabs defaultValue="inputs" className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="inputs">
              <KeyRound className="mr-2 h-4 w-4" /> Inputs from WealthCharts
            </TabsTrigger>
            <TabsTrigger value="outputs">
              <Webhook className="mr-2 h-4 w-4" /> Outputs to WealthCharts
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <ShieldCheck className="mr-2 h-4 w-4" /> Secrets & Go-Live
            </TabsTrigger>
          </TabsList>

          {/* INPUTS TAB ------------------------------------------------- */}
          <TabsContent value="inputs" className="space-y-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>This page does not store secrets</AlertTitle>
              <AlertDescription>
                Values entered here are saved to your browser only (localStorage) as a working
                checklist. API keys and webhook secrets MUST be added in the Supabase secrets
                vault (see the Secrets tab) — never paste them into form fields.
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">1. Environment</CardTitle>
                <CardDescription>API endpoints for sandbox and production tenants.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <FieldRow
                  id="sandboxBaseUrl"
                  label="Sandbox API base URL"
                  required
                  value={form.sandboxBaseUrl}
                  onChange={(v) => update('sandboxBaseUrl', v)}
                  placeholder="https://api-sandbox.wealthcharts.com/v1"
                />
                <FieldRow
                  id="prodBaseUrl"
                  label="Production API base URL"
                  value={form.prodBaseUrl}
                  onChange={(v) => update('prodBaseUrl', v)}
                  placeholder="https://api.wealthcharts.com/v1"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">2. Authentication</CardTitle>
                <CardDescription>Identifier + rotation policy. The key itself goes in Supabase secrets.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <FieldRow
                  id="apiKeyId"
                  label="API key identifier (NOT the secret)"
                  required
                  value={form.apiKeyId}
                  onChange={(v) => update('apiKeyId', v)}
                  placeholder="mer_sandbox_abc123"
                  hint="The public ID/label that pairs with the secret. Safe to store here."
                />
                <FieldRow
                  id="apiKeyRotationPolicy"
                  label="Key rotation policy"
                  value={form.apiKeyRotationPolicy}
                  onChange={(v) => update('apiKeyRotationPolicy', v)}
                  placeholder="90 days, self-service via portal"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">3. Inbound webhook signing</CardTitle>
                <CardDescription>How WealthCharts signs the fill webhooks they push to us.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <FieldRow
                  id="webhookAlgorithm"
                  label="HMAC algorithm"
                  required
                  value={form.webhookAlgorithm}
                  onChange={(v) => update('webhookAlgorithm', v)}
                  placeholder="HMAC-SHA256"
                />
                <FieldRow
                  id="signatureHeader"
                  label="Signature header name"
                  required
                  value={form.signatureHeader}
                  onChange={(v) => update('signatureHeader', v)}
                  placeholder="x-wl-signature"
                />
                <FieldRow
                  id="timestampHeader"
                  label="Timestamp header name"
                  required
                  value={form.timestampHeader}
                  onChange={(v) => update('timestampHeader', v)}
                  placeholder="x-wl-timestamp"
                />
                <FieldRow
                  id="signingFormat"
                  label="Signing format"
                  value={form.signingFormat}
                  onChange={(v) => update('signingFormat', v)}
                  placeholder="timestamp.body OR body-only"
                />
                <FieldRow
                  id="replayWindowSeconds"
                  label="Replay window (seconds)"
                  value={form.replayWindowSeconds}
                  onChange={(v) => update('replayWindowSeconds', v)}
                  placeholder="300"
                />
                <FieldRow
                  id="sourceIps"
                  label="Source IP allowlist (theirs)"
                  value={form.sourceIps}
                  onChange={(v) => update('sourceIps', v)}
                  placeholder="34.x.x.x, 35.x.x.x"
                  hint="IPs they send webhooks from. We log + optionally restrict."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">4. Payload field names</CardTitle>
                <CardDescription>Exact JSON paths in their webhook payloads.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <FieldRow
                  id="accountIdField"
                  label="Account ID field"
                  required
                  value={form.accountIdField}
                  onChange={(v) => update('accountIdField', v)}
                  placeholder="accountId or tenantAccountId"
                />
                <FieldRow
                  id="externalUserIdField"
                  label="External user ID field"
                  value={form.externalUserIdField}
                  onChange={(v) => update('externalUserIdField', v)}
                  placeholder="userId / clientId"
                />
                <FieldRow
                  id="fillIdField"
                  label="Fill / trade unique ID field"
                  required
                  value={form.fillIdField}
                  onChange={(v) => update('fillIdField', v)}
                  placeholder="fillId / executionId"
                />
                <FieldRow
                  id="eventIdField"
                  label="Webhook event ID field"
                  value={form.eventIdField}
                  onChange={(v) => update('eventIdField', v)}
                  placeholder="eventId"
                  hint="Used for idempotent dedupe on our side."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">5. Outbound endpoints (us → them)</CardTitle>
                <CardDescription>Provisioning, disable, reset, reconciliation.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <FieldRow
                  id="provisionEndpoint"
                  label="Provision sim account"
                  required
                  value={form.provisionEndpoint}
                  onChange={(v) => update('provisionEndpoint', v)}
                  placeholder="POST /accounts"
                />
                <FieldRow
                  id="supportedAccountSizes"
                  label="Supported account sizes"
                  value={form.supportedAccountSizes}
                  onChange={(v) => update('supportedAccountSizes', v)}
                  placeholder="25k, 50k, 100k, 150k, 250k"
                />
                <FieldRow
                  id="provisionLatencyMs"
                  label="Provision latency (ms)"
                  value={form.provisionLatencyMs}
                  onChange={(v) => update('provisionLatencyMs', v)}
                  placeholder="2000"
                />
                <FieldRow
                  id="disableEndpoint"
                  label="Disable / freeze account"
                  required
                  value={form.disableEndpoint}
                  onChange={(v) => update('disableEndpoint', v)}
                  placeholder="POST /accounts/{id}/disable"
                />
                <FieldRow
                  id="disableLatencyMs"
                  label="Disable latency (ms)"
                  value={form.disableLatencyMs}
                  onChange={(v) => update('disableLatencyMs', v)}
                  placeholder="<5000 required"
                  hint="Breach enforcement SLA is < 5 seconds."
                />
                <FieldRow
                  id="resetEndpoint"
                  label="Reset / refresh account"
                  value={form.resetEndpoint}
                  onChange={(v) => update('resetEndpoint', v)}
                  placeholder="POST /accounts/{id}/reset"
                />
                <FieldRow
                  id="statusEndpoint"
                  label="Account status (drift reconciliation)"
                  value={form.statusEndpoint}
                  onChange={(v) => update('statusEndpoint', v)}
                  placeholder="GET /accounts/{id}"
                />
                <FieldRow
                  id="fillsLookbackEndpoint"
                  label="Fills lookback (replay)"
                  value={form.fillsLookbackEndpoint}
                  onChange={(v) => update('fillsLookbackEndpoint', v)}
                  placeholder="GET /fills?account={id}&since={ts}"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileJson className="h-4 w-4" /> 6. Sample fill payload (paste here)
                </CardTitle>
                <CardDescription>
                  One real example unlocks parser implementation immediately. Redact account IDs if needed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldRow
                  id="samplePayload"
                  label="Sample webhook body"
                  required
                  multiline
                  value={form.samplePayload}
                  onChange={(v) => update('samplePayload', v)}
                  placeholder='{"eventId":"evt_123","fillId":"fl_456","accountId":"acc_789","symbol":"MESM6","side":"BUY","qty":1,"price":5234.25,"timestamp":"2026-05-18T14:32:11Z"}'
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">7. Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  rows={4}
                  value={form.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  placeholder="Open questions, vendor contact, call notes…"
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* OUTPUTS TAB ------------------------------------------------ */}
          <TabsContent value="outputs" className="space-y-4">
            <Alert>
              <Link2 className="h-4 w-4" />
              <AlertTitle>Give these to WealthCharts</AlertTitle>
              <AlertDescription>
                Copy each value into your vendor onboarding form / email. They need to whitelist,
                configure, or point their systems at these URLs.
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Webhook destination</CardTitle>
                <CardDescription>Where WealthCharts POSTs fill events.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <OutputRow
                  label="Ingest webhook URL"
                  value={ingestWebhookUrl}
                  hint="POST fill events here. Headers x-wl-signature + x-wl-timestamp required."
                />
                <OutputRow
                  label="Smoke test URL"
                  value={smokeTestUrl}
                  hint="Use during integration testing to verify signature + payload normalization."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">White-label / redirect URLs</CardTitle>
                <CardDescription>Trader-facing return paths after platform actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <OutputRow
                  label="Trader dashboard return URL"
                  value={successRedirect}
                  hint="After login/redirect from WealthCharts platform, send traders here."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Operational contacts</CardTitle>
                <CardDescription>What to put on their vendor intake form.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Product name</span>
                  <span className="font-mono">Meridian</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Webhook signature scheme expected</span>
                  <span className="font-mono">HMAC-SHA256 (timestamp.body)</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Replay window</span>
                  <span className="font-mono">±300 seconds</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Breach disable SLA we require</span>
                  <span className="font-mono">&lt; 5 seconds</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Account sizes we will provision</span>
                  <span className="font-mono">25k / 50k / 100k / 150k / 250k</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* SECRETS TAB ------------------------------------------------ */}
          <TabsContent value="secrets" className="space-y-4">
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Secrets live in Supabase, not in this app</AlertTitle>
              <AlertDescription>
                The two values below must be added in the Supabase Edge Function secrets vault.
                The WealthCharts adapter reads them at runtime via <code>Deno.env.get()</code>.
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Required secrets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sm font-semibold">WEALTHCHARTS_API_KEY</code>
                    <Badge variant="secondary">outbound</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Used for provisioning sim accounts, disabling accounts on breach, and querying
                    account status. Paste the sandbox API key WealthCharts gives you.
                  </p>
                </div>

                <div className="space-y-2 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sm font-semibold">WEALTHCHARTS_WEBHOOK_SECRET</code>
                    <Badge variant="secondary">inbound</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Used to verify HMAC signatures on incoming fill webhooks. Without it,
                    every inbound webhook is rejected.
                  </p>
                </div>

                <Button asChild className="w-full" variant="outline">
                  <a href={supabaseSecretsUrl} target="_blank" rel="noreferrer">
                    Open Supabase secrets vault
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>

            <Separator />

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Go-live checklist</CardTitle>
                <CardDescription>In order. Each step gates the next.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-sm">
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">1</Badge>
                    <span>Complete vendor Call #1 (gate decision). All 6 capabilities = YES.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">2</Badge>
                    <span>Capture all required fields on the Inputs tab.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">3</Badge>
                    <span>Add <code>WEALTHCHARTS_API_KEY</code> + <code>WEALTHCHARTS_WEBHOOK_SECRET</code> in Supabase.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">4</Badge>
                    <span>Implement adapter stubs (providers/wealthcharts + brokers/wealthcharts).</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">5</Badge>
                    <span>Hit <code>bridge-smoke-test</code> → must return green.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">6</Badge>
                    <span>Provision a test account, place a sim trade, confirm it lands in <code>trades</code>.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">7</Badge>
                    <span>Trigger a synthetic breach, confirm disable round-trips in &lt; 5 seconds.</span>
                  </li>
                  <li className="flex gap-3">
                    <Badge variant="outline" className="shrink-0">8</Badge>
                    <span>Flip <code>ACTIVE_PROVIDER=wealthcharts</code> in system settings.</span>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}