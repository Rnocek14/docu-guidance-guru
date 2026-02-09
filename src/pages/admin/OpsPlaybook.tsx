import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { AlertTriangle, Shield, DollarSign, Clock, Zap, Globe, Activity, Users, ShoppingCart, TrendingUp, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';

interface Runbook {
  id: string;
  title: string;
  severity: 'info' | 'warn' | 'critical' | 'emergency';
  icon: React.ReactNode;
  trigger: string;
  steps: string[];
  links?: { label: string; href: string }[];
  sqlSnippet?: string;
}

const severityConfig = {
  info: { label: 'INFO', variant: 'secondary' as const, className: '' },
  warn: { label: 'WARN', variant: 'outline' as const, className: 'border-yellow-500 text-yellow-600' },
  critical: { label: 'CRITICAL', variant: 'destructive' as const, className: '' },
  emergency: { label: 'EMERGENCY', variant: 'destructive' as const, className: 'bg-red-700' },
};

const runbooks: Runbook[] = [
  {
    id: 'daily-checks',
    title: 'Daily Morning Checks',
    severity: 'info',
    icon: <Activity className="h-5 w-5" />,
    trigger: 'Every morning — first 5 minutes of your day',
    steps: [
      'Check cron health on System Overview — all jobs should be green',
      'Check dispute rate on Admin Dashboard — should be < 0.20%',
      'Check breaker state on System Overview — should be "normal"',
      'Check net buffer on Liability Dashboard — should be positive',
      'Check pending payouts count on Admin Dashboard — reasonable count',
      'Check staff_notifications table for unacked emergencies',
      'Check fulfillment queue for stuck rows (> 10 min in processing)',
    ],
    links: [
      { label: 'System Overview', href: '/admin/system' },
      { label: 'Liability Dashboard', href: '/admin/liability' },
      { label: 'Admin Dashboard', href: '/admin' },
    ],
  },
  {
    id: 'dispute-rate',
    title: 'Dispute Rate Alert',
    severity: 'critical',
    icon: <AlertTriangle className="h-5 w-5" />,
    trigger: 'Dispute rate ≥ 0.20% (warn), ≥ 0.30% (high), ≥ 0.40% (severe), ≥ 0.50% (emergency auto-pause)',
    steps: [
      'Check 7-day vs 30-day split — is it a spike or a trend?',
      'Identify dispute sources — which users/cards are generating disputes?',
      'Check for patterns: same card fingerprint, country, or IP range',
      'At 0.30%: investigate sources, consider tightening refund policy',
      'At 0.40%: add checkout friction, block risky card BINs',
      'At 0.50%: inbound auto-paused — DO NOT unpause until root cause found',
      'Contact Stripe proactively if rate hits 0.40%+',
      'Only unpause when 7-day rate trends back below 0.30%',
    ],
    links: [
      { label: 'Admin Dashboard (Dispute Card)', href: '/admin' },
    ],
    sqlSnippet: `SELECT user_id, COUNT(*), SUM(amount)\nFROM chargeback_events\nWHERE occurred_at > now() - interval '30 days'\nGROUP BY user_id ORDER BY count DESC LIMIT 20;`,
  },
  {
    id: 'breaker-fired',
    title: 'Economic Breaker Fired',
    severity: 'critical',
    icon: <Zap className="h-5 w-5" />,
    trigger: 'Breaker level changes to "elevated" (approvals blocked) or "critical" (payouts + evals frozen)',
    steps: [
      'Go to System Overview → Breaker Panel to see current state',
      'Review pass rate, pending liability, and net buffer numbers',
      'If pass rate is genuinely high: review cohort rules, check for gaming',
      'If false positive (small sample): breaker auto-resolves on next daily-risk-snapshot',
      'DO NOT manually override the breaker state',
      'Blocked payouts are safe — they process when breaker clears',
      'If rules need tightening: use safety_setting_changes (requires 2-key approval)',
    ],
    links: [
      { label: 'System Overview', href: '/admin/system' },
      { label: 'Cohorts', href: '/admin/cohorts' },
    ],
  },
  {
    id: 'liability-negative',
    title: 'Liability Buffer Negative',
    severity: 'warn',
    icon: <DollarSign className="h-5 w-5" />,
    trigger: 'check-liability-alert fires — net buffer goes negative',
    steps: [
      'Check pending payout obligations vs cash reserves',
      'Option 1: Slow down payout approvals (don\'t deny — take more review time)',
      'Option 2: Pause new intake temporarily (global_intake_active = false)',
      'Option 3: Increase cash_reserve setting if funds are available',
      'DO NOT reject legitimate payouts to fix the buffer — this is an intake/pricing problem',
    ],
    links: [
      { label: 'Liability Dashboard', href: '/admin/liability' },
    ],
    sqlSnippet: `SELECT status, COUNT(*), SUM(amount)\nFROM payouts\nWHERE status IN ('pending','under_review','approved','payment_initiated')\nGROUP BY status;`,
  },
  {
    id: 'stuck-payout',
    title: 'Payout Stuck in payment_initiated',
    severity: 'warn',
    icon: <Clock className="h-5 w-5" />,
    trigger: 'A payout has been in payment_initiated for > 48 hours',
    steps: [
      'Check payout_payments table for stuck "initiated" records',
      'Check the provider dashboard (Stripe/Wise) for actual payment status',
      'If confirmed in provider but webhook missed: call payout-webhook-handler manually',
      'If failed in provider: update via webhook handler with failure data',
      'NEVER manually UPDATE the payouts table — always use the webhook handler',
      'Communicate with trader if resolution takes > 72 hours',
    ],
    sqlSnippet: `SELECT pp.*, p.amount, p.account_id\nFROM payout_payments pp\nJOIN payouts p ON p.id = pp.payout_id\nWHERE pp.status = 'initiated'\nAND pp.initiated_at < now() - interval '48 hours';`,
  },
  {
    id: 'stripe-review',
    title: 'Stripe Account Under Review',
    severity: 'emergency',
    icon: <Globe className="h-5 w-5" />,
    trigger: 'Email from Stripe or dashboard shows account restrictions — EXISTENTIAL RISK',
    steps: [
      'IMMEDIATELY pause inbound payments if not already paused',
      'Gather evidence: dispute history, resolution rates, monitoring systems',
      'Respond to Stripe within 24 hours with business explanation',
      'Explain: simulated trading evaluations, not real market exposure',
      'Show your dispute prevention and auto-pause mechanisms',
      'Activate secondary processor plan if available',
      'DO NOT continue processing payments while under review',
    ],
  },
  {
    id: 'cron-failure',
    title: 'Cron Job Failure',
    severity: 'warn',
    icon: <Activity className="h-5 w-5" />,
    trigger: 'System Overview shows red/yellow cron health for any job',
    steps: [
      'Check recent runs in cron_http_runs table for the failing job',
      'Check edge function logs in Supabase dashboard',
      'Common causes: CRON_SECRET mismatch (401/503), deployment failure (500), DB timeout (504)',
      'Manually trigger missed run via curl with X-Cron-Secret header',
      'Verify recovery by checking next successful cron_http_runs entry',
    ],
    links: [
      { label: 'System Overview', href: '/admin/system' },
    ],
  },
  {
    id: 'abuse-wave',
    title: 'Abuse Wave / Coordinated Fraud',
    severity: 'critical',
    icon: <Users className="h-5 w-5" />,
    trigger: 'Multiple flags/fraud reviews for linked accounts — shared fingerprints, IPs, rapid signups',
    steps: [
      'Assess scope: query device_fingerprints for clusters with > 3 devices',
      'Freeze payouts for affected users (profiles.payouts_hold = true)',
      'DO NOT auto-ban or auto-deny — flag for human review',
      'If wave is active: pause global intake immediately',
      'Document everything — create fraud_reviews for each entity',
      'After investigation: clear holds for legitimate users, escalate confirmed fraud',
    ],
    links: [
      { label: 'Review Queue', href: '/risk/queue' },
    ],
  },
  {
    id: 'fulfillment-stuck',
    title: 'Fulfillment Queue Stuck',
    severity: 'warn',
    icon: <ShoppingCart className="h-5 w-5" />,
    trigger: 'checkout_fulfillment_queue has rows stuck in processing/queued > 10 minutes',
    steps: [
      'Check queue for stuck rows: status = processing or queued',
      'If processing and stuck > 10 min: retry-fulfillment-queue cron should auto-reset',
      'If repeatedly failed (attempts > 3): check last_error for root cause',
      'Common causes: breaker blocking account creation, cohort not found, duplicate session',
      'If cron is down: trigger retry-fulfillment-queue manually',
      'USER IMPACT: user paid but has no account — prioritize this',
    ],
  },
  {
    id: 'pass-rate',
    title: 'Pass Rate Anomaly',
    severity: 'info',
    icon: <TrendingUp className="h-5 w-5" />,
    trigger: 'Daily risk snapshot shows pass rate outside expected band (typically 5–15%)',
    steps: [
      'Check recent risk_snapshots for pass_rate trend over 7 days',
      'If HIGH (> 20%): check if profit targets are too easy, look for gaming patterns',
      'The economic breaker should be handling high pass rates automatically',
      'Consider proposing rule tightening via safety_setting_changes',
      'If ZERO: check if trade ingestion is working, verify account status transitions',
      'Zero pass rate might be a system issue, not a market issue',
    ],
    links: [
      { label: 'Monte Carlo', href: '/admin/monte-carlo' },
      { label: 'System Overview', href: '/admin/system' },
    ],
  },
];

const killSwitches = [
  { name: 'Pause inbound payments', table: 'payment_system_state', column: 'is_paused_inbound', effect: 'Blocks all new checkouts' },
  { name: 'Pause outbound payments', table: 'payment_system_state', column: 'is_paused_outbound', effect: 'Blocks all payout disbursements' },
  { name: 'Pause new signups', table: 'system_settings', column: 'global_intake_active = false', effect: 'Blocks new account creation' },
  { name: 'Freeze user payouts', table: 'profiles', column: 'payouts_frozen', effect: 'Blocks specific user payouts' },
  { name: 'Hold user payouts', table: 'profiles', column: 'payouts_hold', effect: 'Soft hold, requires review' },
  { name: 'Block card payments', table: 'profiles', column: 'card_payments_blocked', effect: 'Blocks specific user card' },
  { name: 'Economic breaker', table: 'econ_breaker_state', column: 'breaker_level', effect: 'Auto-managed, blocks approvals/payouts' },
];

export default function OpsPlaybook() {
  return (
    <DashboardLayout title="Ops Playbook" navItems={adminNavItems}>
      <div className="space-y-6 max-w-4xl">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            Operations Playbook
          </h2>
          <p className="text-muted-foreground">
            Incident runbooks for every automated alert. Follow step-by-step when things go wrong.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Full version: <code>docs/OPS_PLAYBOOK.md</code> in the repository
          </p>
        </div>

        {/* Crisis priority order */}
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-destructive" />
              Crisis Priority Order
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal list-inside text-sm space-y-1 text-muted-foreground">
              <li><strong>Pause inbound</strong> — stop new money in</li>
              <li><strong>Pause outbound</strong> — stop money going out</li>
              <li><strong>Pause intake</strong> — stop new accounts</li>
              <li><strong>Assess</strong> — read the relevant runbook</li>
              <li><strong>Communicate</strong> — contact affected parties</li>
              <li><strong>Resolve</strong> — fix root cause</li>
              <li><strong>Unpause</strong> — in reverse order: intake → outbound → inbound</li>
            </ol>
          </CardContent>
        </Card>

        {/* Runbook accordion */}
        <Accordion type="multiple" className="space-y-2">
          {runbooks.map((rb) => {
            const sev = severityConfig[rb.severity];
            return (
              <AccordionItem key={rb.id} value={rb.id} className="border rounded-lg px-1">
                <AccordionTrigger className="hover:no-underline py-3 px-3">
                  <div className="flex items-center gap-3 text-left">
                    {rb.icon}
                    <span className="font-medium">{rb.title}</span>
                    <Badge variant={sev.variant} className={sev.className}>
                      {sev.label}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-4">
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Trigger</p>
                      <p className="text-sm">{rb.trigger}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Steps</p>
                      <ol className="list-decimal list-inside text-sm space-y-1 mt-1">
                        {rb.steps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                    {rb.sqlSnippet && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Diagnostic Query</p>
                        <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto mt-1">
                          <code>{rb.sqlSnippet}</code>
                        </pre>
                      </div>
                    )}
                    {rb.links && rb.links.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {rb.links.map((link) => (
                          <Link
                            key={link.href}
                            to={link.href}
                            className="text-xs text-primary underline hover:text-primary/80"
                          >
                            {link.label} →
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>

        {/* Kill switch reference */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Kill Switch Reference
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium">Switch</th>
                    <th className="text-left py-2 pr-4 font-medium">Table</th>
                    <th className="text-left py-2 pr-4 font-medium">Column</th>
                    <th className="text-left py-2 font-medium">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {killSwitches.map((ks) => (
                    <tr key={ks.name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{ks.name}</td>
                      <td className="py-2 pr-4"><code className="text-xs bg-muted px-1 py-0.5 rounded">{ks.table}</code></td>
                      <td className="py-2 pr-4"><code className="text-xs bg-muted px-1 py-0.5 rounded">{ks.column}</code></td>
                      <td className="py-2 text-muted-foreground">{ks.effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
