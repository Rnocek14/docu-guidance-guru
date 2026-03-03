import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Lock, ArrowRight, TrendingUp, Wallet, Clock, Trophy } from 'lucide-react';
import { LADDER_TIERS, getUnlockBenefits, type LadderProgress, type UnlockBenefit } from '@/lib/ladder-spec';

interface UnlockRoadmapProps {
  progress: LadderProgress;
}

const BENEFIT_ICONS: Record<UnlockBenefit['icon'], typeof TrendingUp> = {
  split: TrendingUp,
  cap: Wallet,
  cooldown: Clock,
  lifetime: Trophy,
};

export function UnlockRoadmap({ progress }: UnlockRoadmapProps) {
  const { currentTierIndex, cleanPayoutCount } = progress;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          Unlock Roadmap
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {LADDER_TIERS.map((tier, idx) => {
            const isUnlocked = idx <= currentTierIndex;
            const isCurrent = idx === currentTierIndex;
            const isNext = idx === currentTierIndex + 1;
            const prevTier = idx > 0 ? LADDER_TIERS[idx - 1] : null;
            const benefits = prevTier ? getUnlockBenefits(prevTier, tier) : [];
            const payoutsAway = Math.max(0, tier.cleanPayoutsRequired - cleanPayoutCount);

            return (
              <div key={tier.id} className="relative">
                {/* Connector line */}
                {idx > 0 && (
                  <div
                    className={`absolute left-[11px] -top-4 h-4 w-0.5 ${
                      isUnlocked ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                )}

                <div className="flex items-start gap-3">
                  {/* Status icon */}
                  <div className="mt-0.5">
                    {isUnlocked ? (
                      <CheckCircle2 className="h-6 w-6 text-primary" />
                    ) : (
                      <Lock className="h-6 w-6 text-muted-foreground/40" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium text-sm ${
                          isUnlocked ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {tier.name}
                      </span>
                      {isCurrent && (
                        <Badge variant="default" className="text-[10px] px-1.5 py-0">
                          Current
                        </Badge>
                      )}
                      {isNext && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {payoutsAway} clean payout{payoutsAway !== 1 ? 's' : ''} away
                        </Badge>
                      )}
                      {!isUnlocked && !isNext && (
                        <span className="text-[10px] text-muted-foreground">
                          {tier.cleanPayoutsRequired} clean payouts
                        </span>
                      )}
                    </div>

                    {/* Benefits preview (for non-starter tiers) */}
                    {benefits.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {benefits.map((b) => {
                          const Icon = BENEFIT_ICONS[b.icon];
                          return (
                            <span
                              key={b.icon}
                              className={`inline-flex items-center gap-1 text-[11px] rounded-md px-1.5 py-0.5 ${
                                isUnlocked
                                  ? 'bg-primary/10 text-primary'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              <Icon className="h-3 w-3" />
                              {b.label}: {b.fromValue} → {b.toValue}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
