import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Trophy, TrendingUp, Clock, Wallet, Shield } from 'lucide-react';
import type { LadderProgress } from '@/lib/ladder-spec';

interface TierStatusCardProps {
  progress: LadderProgress;
}

const TIER_COLORS: Record<string, string> = {
  starter: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  pro: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  elite: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
};

const TIER_ICONS: Record<string, typeof Trophy> = {
  starter: Shield,
  pro: TrendingUp,
  elite: Trophy,
};

export function TierStatusCard({ progress }: TierStatusCardProps) {
  const { currentTier, nextTier, payoutsToNextTier, cleanPayoutCount, isMaxTier } = progress;
  const TierIcon = TIER_ICONS[currentTier.id] ?? Shield;
  const colorClass = TIER_COLORS[currentTier.id] ?? TIER_COLORS.starter;

  // Progress toward next tier (0–100)
  const progressPct = nextTier
    ? ((cleanPayoutCount - currentTier.cleanPayoutsRequired) /
        (nextTier.cleanPayoutsRequired - currentTier.cleanPayoutsRequired)) *
      100
    : 100;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TierIcon className="h-4 w-4 text-muted-foreground" />
            Ladder Tier
          </CardTitle>
          <Badge variant="outline" className={colorClass}>
            {currentTier.name}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current benefits */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Split</span>
            <span className="font-semibold ml-auto">{currentTier.splitPercent}%</span>
          </div>
          <div className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">1st Cap</span>
            <span className="font-semibold ml-auto">${currentTier.firstPayoutCap}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Cooldown</span>
            <span className="font-semibold ml-auto">{currentTier.cooldownDays}d</span>
          </div>
          <div className="flex items-center gap-2">
            <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Lifetime</span>
            <span className="font-semibold ml-auto">{currentTier.lifetimeCapMultiple}×</span>
          </div>
        </div>

        {/* Progress toward next tier */}
        {!isMaxTier && nextTier ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {cleanPayoutCount} clean payout{cleanPayoutCount !== 1 ? 's' : ''}
              </span>
              <span className="font-medium">
                {payoutsToNextTier} more → {nextTier.name}
              </span>
            </div>
            <Progress value={progressPct} className="h-2" />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground text-center py-1 rounded-md bg-muted/50">
            🏆 Maximum tier reached
          </div>
        )}

        {/* Pacing note */}
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Payouts queued by the monthly stability budget are paid next window and can still count as clean once paid.
        </p>
      </CardContent>
    </Card>
  );
}
