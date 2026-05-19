import { ReactNode } from 'react';
import {
  LayoutDashboard, Shield, AlertTriangle, Users, Settings,
  FileText, Flag, CreditCard, Activity, Cpu, Wrench, Plug, LineChart, Gift, Handshake, Gauge,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  section?: 'daily' | 'tools';
}

export const missionControlNavItems: NavItem[] = [
  // ── Daily (always visible) ──
  { label: 'Mission Control', href: '/admin', icon: <Cpu className="h-5 w-5" />, section: 'daily' },
  { label: 'Review Queue', href: '/risk/queue', icon: <Flag className="h-5 w-5" />, section: 'daily' },

  // ── Tools (collapsed) ──
  { label: 'Full Governor', href: '/admin/governor', icon: <Shield className="h-5 w-5" />, section: 'tools' },
  { label: 'Morning Checks', href: '/admin/ops-metrics', icon: <Activity className="h-5 w-5" />, section: 'tools' },
  { label: 'Risk Dashboard', href: '/risk', icon: <AlertTriangle className="h-5 w-5" />, section: 'tools' },
  { label: 'Payout Liability', href: '/admin/liability', icon: <CreditCard className="h-5 w-5" />, section: 'tools' },
  { label: 'Monte Carlo', href: '/admin/monte-carlo', icon: <Activity className="h-5 w-5" />, section: 'tools' },
  { label: 'Treasury / Scaling', href: '/admin/treasury', icon: <Gauge className="h-5 w-5" />, section: 'tools' },
  { label: 'System Overview', href: '/admin/system', icon: <Shield className="h-5 w-5" />, section: 'tools' },
  { label: 'Users', href: '/admin/users', icon: <Users className="h-5 w-5" />, section: 'tools' },
  { label: 'Cohorts', href: '/admin/cohorts', icon: <Settings className="h-5 w-5" />, section: 'tools' },
  { label: 'Audit Logs', href: '/admin/audit', icon: <FileText className="h-5 w-5" />, section: 'tools' },
  { label: 'Ops Playbook', href: '/admin/ops-playbook', icon: <FileText className="h-5 w-5" />, section: 'tools' },
  { label: 'Tier Readiness', href: '/admin/tier-readiness', icon: <Shield className="h-5 w-5" />, section: 'tools' },
  { label: 'Launch Readiness', href: '/admin/readiness', icon: <Shield className="h-5 w-5" />, section: 'tools' },
  { label: 'QA Scan', href: '/admin/qa-scan', icon: <Activity className="h-5 w-5" />, section: 'tools' },
  { label: 'Email Triage', href: '/admin/support-emails', icon: <FileText className="h-5 w-5" />, section: 'tools' },
  { label: 'WealthCharts Setup', href: '/admin/wealthcharts', icon: <Plug className="h-5 w-5" />, section: 'tools' },
  { label: 'Cohort Projection', href: '/admin/projection', icon: <LineChart className="h-5 w-5" />, section: 'tools' },
  { label: 'Share Bonuses', href: '/admin/share-bonuses', icon: <Gift className="h-5 w-5" />, section: 'tools' },
  { label: 'Affiliates', href: '/admin/affiliates', icon: <Handshake className="h-5 w-5" />, section: 'tools' },
];
