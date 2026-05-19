import { ReactNode } from 'react';
import {
  LayoutDashboard, Shield, AlertTriangle, Users, Settings,
  FileText, Flag, CreditCard, Activity, Cpu, Wrench, Plug, LineChart, Gift, Handshake, Gauge,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  section?: string;
}

export const missionControlNavItems: NavItem[] = [
  // ── Daily (always visible, no header) ──
  { label: 'Mission Control', href: '/admin', icon: <Cpu className="h-5 w-5" />, section: 'daily' },
  { label: 'Review Queue', href: '/risk/queue', icon: <Flag className="h-5 w-5" />, section: 'daily' },

  // ── Projections & Analytics ──
  { label: 'Treasury / Scaling', href: '/admin/treasury', icon: <Gauge className="h-5 w-5" />, section: 'Projections & Analytics' },
  { label: 'Monte Carlo', href: '/admin/monte-carlo', icon: <Activity className="h-5 w-5" />, section: 'Projections & Analytics' },
  { label: 'Cohort Projection', href: '/admin/projection', icon: <LineChart className="h-5 w-5" />, section: 'Projections & Analytics' },
  { label: 'Payout Liability', href: '/admin/liability', icon: <CreditCard className="h-5 w-5" />, section: 'Projections & Analytics' },

  // ── Risk & Ops ──
  { label: 'Full Governor', href: '/admin/governor', icon: <Shield className="h-5 w-5" />, section: 'Risk & Ops' },
  { label: 'Risk Dashboard', href: '/risk', icon: <AlertTriangle className="h-5 w-5" />, section: 'Risk & Ops' },
  { label: 'Morning Checks', href: '/admin/ops-metrics', icon: <Activity className="h-5 w-5" />, section: 'Risk & Ops' },
  { label: 'Ops Playbook', href: '/admin/ops-playbook', icon: <FileText className="h-5 w-5" />, section: 'Risk & Ops' },
  { label: 'System Overview', href: '/admin/system', icon: <Shield className="h-5 w-5" />, section: 'Risk & Ops' },
  { label: 'QA Scan', href: '/admin/qa-scan', icon: <Activity className="h-5 w-5" />, section: 'Risk & Ops' },

  // ── Users & Cohorts ──
  { label: 'Users', href: '/admin/users', icon: <Users className="h-5 w-5" />, section: 'Users & Cohorts' },
  { label: 'Cohorts', href: '/admin/cohorts', icon: <Settings className="h-5 w-5" />, section: 'Users & Cohorts' },
  { label: 'Tier Readiness', href: '/admin/tier-readiness', icon: <Shield className="h-5 w-5" />, section: 'Users & Cohorts' },
  { label: 'Launch Readiness', href: '/admin/readiness', icon: <Shield className="h-5 w-5" />, section: 'Users & Cohorts' },

  // ── Growth ──
  { label: 'Affiliates', href: '/admin/affiliates', icon: <Handshake className="h-5 w-5" />, section: 'Growth' },
  { label: 'Share Bonuses', href: '/admin/share-bonuses', icon: <Gift className="h-5 w-5" />, section: 'Growth' },

  // ── Logs & Setup ──
  { label: 'Audit Logs', href: '/admin/audit', icon: <FileText className="h-5 w-5" />, section: 'Logs & Setup' },
  { label: 'Email Triage', href: '/admin/support-emails', icon: <FileText className="h-5 w-5" />, section: 'Logs & Setup' },
  { label: 'WealthCharts Setup', href: '/admin/wealthcharts', icon: <Plug className="h-5 w-5" />, section: 'Logs & Setup' },
];
