import { ReactNode } from 'react';
import {
  LayoutDashboard, Shield, AlertTriangle, Users, Settings,
  FileText, Flag, CreditCard, Activity, Cpu, Wrench, Plug, LineChart, Gift, Handshake, Gauge, Inbox, Eye,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  section?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// One-operator cockpit layout.
//
//   Daily   — pages you open every morning. Always visible, no group header.
//   Tools   — everything else. Collapsed by default. Searchable.
//   Advanced — experimental / R&D surfaces. Hidden unless
//             VITE_SHOW_ADVANCED_ADMIN=true (or localStorage.SHOW_ADVANCED_ADMIN).
//
// Nothing is deleted. Pages without nav entries (sweep, scenario-replay, etc.)
// stay routable; they just don't clutter the sidebar.
// ──────────────────────────────────────────────────────────────────────────────

const DAILY: NavItem[] = [
  { label: 'Mission Control', href: '/admin', icon: <Cpu className="h-5 w-5" />, section: 'daily' },
  { label: 'Review Queue', href: '/risk/queue', icon: <Flag className="h-5 w-5" />, section: 'daily' },
  { label: 'Treasury', href: '/admin/treasury', icon: <Gauge className="h-5 w-5" />, section: 'daily' },
  { label: 'Email Triage', href: '/admin/support-emails', icon: <Inbox className="h-5 w-5" />, section: 'daily' },
  { label: 'Audit Logs', href: '/admin/audit', icon: <FileText className="h-5 w-5" />, section: 'daily' },
];

const TOOLS: NavItem[] = [
  { label: 'Full Governor', href: '/admin/governor', icon: <Shield className="h-5 w-5" />, section: 'Tools' },
  { label: 'Payout Liability', href: '/admin/liability', icon: <CreditCard className="h-5 w-5" />, section: 'Tools' },
  { label: 'Risk Dashboard', href: '/risk', icon: <AlertTriangle className="h-5 w-5" />, section: 'Tools' },
  { label: 'Morning Checks', href: '/admin/ops-metrics', icon: <Activity className="h-5 w-5" />, section: 'Tools' },
  { label: 'Monte Carlo', href: '/admin/monte-carlo', icon: <Activity className="h-5 w-5" />, section: 'Tools' },
  { label: 'Cohort Projection', href: '/admin/projection', icon: <LineChart className="h-5 w-5" />, section: 'Tools' },
  { label: 'System Overview', href: '/admin/system', icon: <Shield className="h-5 w-5" />, section: 'Tools' },
  { label: 'Ops Playbook', href: '/admin/ops-playbook', icon: <FileText className="h-5 w-5" />, section: 'Tools' },
  { label: 'Users', href: '/admin/users', icon: <Users className="h-5 w-5" />, section: 'Tools' },
  { label: 'Cohorts', href: '/admin/cohorts', icon: <Settings className="h-5 w-5" />, section: 'Tools' },
  { label: 'Tier Readiness', href: '/admin/tier-readiness', icon: <Shield className="h-5 w-5" />, section: 'Tools' },
  { label: 'Launch Readiness', href: '/admin/readiness', icon: <Shield className="h-5 w-5" />, section: 'Tools' },
  { label: 'QA Scan', href: '/admin/qa-scan', icon: <Activity className="h-5 w-5" />, section: 'Tools' },
  { label: 'Affiliates', href: '/admin/affiliates', icon: <Handshake className="h-5 w-5" />, section: 'Tools' },
  { label: 'Share Bonuses', href: '/admin/share-bonuses', icon: <Gift className="h-5 w-5" />, section: 'Tools' },
  { label: 'WealthCharts Setup', href: '/admin/wealthcharts', icon: <Plug className="h-5 w-5" />, section: 'Tools' },
  { label: 'Competitor Intel', href: '/admin/intel', icon: <Eye className="h-5 w-5" />, section: 'Tools' },
];

// Advanced / experimental — keep code, hide UI. Move items here as they age out.
const ADVANCED: NavItem[] = [
  // (intentionally empty; add experimental routes here as they appear)
];

function showAdvanced(): boolean {
  try {
    if (typeof window !== 'undefined' && window.localStorage?.getItem('SHOW_ADVANCED_ADMIN') === 'true') {
      return true;
    }
  } catch {
    /* localStorage unavailable */
  }
  return import.meta.env.VITE_SHOW_ADVANCED_ADMIN === 'true';
}

export const missionControlNavItems: NavItem[] = [
  ...DAILY,
  ...TOOLS,
  ...(showAdvanced() ? ADVANCED : []),
];
