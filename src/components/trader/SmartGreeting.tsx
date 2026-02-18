import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { Account, Cohort } from '@/lib/types';

interface SmartGreetingProps {
  accounts: (Account & { cohort: Cohort })[];
}

function getTimeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getStatusLine(accounts: (Account & { cohort: Cohort })[]): string | null {
  if (!accounts.length) return null;

  // Check for payout in progress
  const payoutAccount = accounts.find(
    (a) => a.status === 'payout_requested' || a.status === 'payout_under_review',
  );
  if (payoutAccount) {
    return `Payout under review on #${payoutAccount.account_number} — we'll notify you.`;
  }

  // Find account closest to profit target
  const active = accounts.filter((a) => a.status === 'active');
  if (!active.length) return null;

  let best: { pct: number; num: string } | null = null;
  for (const a of active) {
    const target = a.cohort?.profit_target_percent;
    if (!target) continue;
    const pct = Math.min(100, ((a.total_pnl / a.starting_balance) * 100 / target) * 100);
    if (!best || pct > best.pct) {
      best = { pct, num: a.account_number };
    }
  }

  if (best) {
    if (best.pct >= 100) return `Account #${best.num} has met its profit target!`;
    return `Best account #${best.num}: ${Math.round(best.pct)}% to target.`;
  }

  // Fallback: days since last trade
  const lastTrade = accounts
    .map((a) => (a as any).last_trade_at as string | null)
    .filter(Boolean)
    .sort()
    .pop();
  if (lastTrade) {
    const days = Math.floor((Date.now() - new Date(lastTrade).getTime()) / 86400000);
    if (days >= 2) return `Last trade: ${days} days ago.`;
  }

  return null;
}

export function SmartGreeting({ accounts }: SmartGreetingProps) {
  const { profile } = useAuth();

  const greeting = useMemo(() => getTimeGreeting(), []);
  const firstName = profile?.full_name?.split(' ')[0] || 'Trader';
  const statusLine = useMemo(() => getStatusLine(accounts), [accounts]);

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight">
        {greeting}, {firstName}
      </h2>
      <p className="text-muted-foreground">
        {statusLine || "Here's an overview of your trading progress."}
      </p>
    </div>
  );
}
