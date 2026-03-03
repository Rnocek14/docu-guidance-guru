import { useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Clock, Wallet, Trophy, ArrowRight, Shield } from 'lucide-react';
import type { LadderTier } from '@/lib/ladder-spec';
import { getUnlockBenefits } from '@/lib/ladder-spec';
import { Link } from 'react-router-dom';
import { track } from '@/lib/track';
import type { LucideIcon } from 'lucide-react';

interface TierUpCelebrationModalProps {
  open: boolean;
  onClose: () => void;
  fromTier: LadderTier;
  toTier: LadderTier;
  cleanPayoutNumber: number;
}

const TIER_STYLES: Record<LadderTier['id'], { bg: string; text: string; border: string; glow: string }> = {
  starter: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-500/20',
    glow: 'shadow-blue-500/20',
  },
  pro: {
    bg: 'bg-purple-500/10',
    text: 'text-purple-600 dark:text-purple-400',
    border: 'border-purple-500/20',
    glow: 'shadow-purple-500/20',
  },
  elite: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/20',
    glow: 'shadow-amber-500/20',
  },
};

const TIER_ICONS: Record<LadderTier['id'], LucideIcon> = {
  starter: Shield,
  pro: TrendingUp,
  elite: Trophy,
};

const BENEFIT_ICONS = {
  split: TrendingUp,
  cap: Wallet,
  cooldown: Clock,
  lifetime: Trophy,
};

const TIER_COPY: Record<LadderTier['id'], { body: string }> = {
  pro: {
    body: 'Clean payouts mean no flags, no freezes, and disciplined performance. Keep stacking them.',
  },
  elite: {
    body: 'Elite status reflects sustained, compliant performance. Higher split. Faster withdrawals. Bigger runway.',
  },
};

export function TierUpCelebrationModal({
  open,
  onClose,
  fromTier,
  toTier,
  cleanPayoutNumber,
}: TierUpCelebrationModalProps) {
  const toStyle = TIER_STYLES[toTier.id] ?? TIER_STYLES.starter;
  const fromStyle = TIER_STYLES[fromTier.id] ?? TIER_STYLES.starter;
  const ToIcon = TIER_ICONS[toTier.id] ?? Shield;
  const FromIcon = TIER_ICONS[fromTier.id] ?? Shield;
  const benefits = getUnlockBenefits(fromTier, toTier);
  const copy = TIER_COPY[toTier.id] ?? TIER_COPY.pro;

  // Analytics: fire once when modal opens
  useEffect(() => {
    if (open) {
      track('tier_up_viewed', { from: fromTier.id, to: toTier.id, payout: cleanPayoutNumber });
    }
  }, [open, fromTier.id, toTier.id, cleanPayoutNumber]);

  const handleCtaClick = () => {
    track('tier_up_cta_clicked', { to: toTier.id, cta: 'view_benefits' });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden">
        {/* Accessible title + description (visually hidden) */}
        <DialogTitle className="sr-only">You've unlocked {toTier.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Clean payout #{cleanPayoutNumber} confirmed. You've advanced from {fromTier.name} to {toTier.name}.
        </DialogDescription>
        {/* Header band */}
        <div className={`px-6 pt-8 pb-6 text-center ${toStyle.bg}`}>
          <div className="flex items-center justify-center gap-3 mb-4">
            {/* From tier */}
            <div className="flex flex-col items-center gap-1">
              <div className={`rounded-full p-2 border ${fromStyle.border} ${fromStyle.bg}`}>
                <FromIcon className={`h-5 w-5 ${fromStyle.text}`} />
              </div>
              <span className={`text-xs font-medium ${fromStyle.text}`}>{fromTier.name}</span>
            </div>

            <ArrowRight className="h-5 w-5 text-muted-foreground" />

            {/* To tier — emphasized */}
            <div className="flex flex-col items-center gap-1">
              <div className={`rounded-full p-3 border-2 ${toStyle.border} ${toStyle.bg} shadow-lg ${toStyle.glow}`}>
                <ToIcon className={`h-6 w-6 ${toStyle.text}`} />
              </div>
              <Badge variant="outline" className={`${toStyle.text} ${toStyle.border} ${toStyle.bg} font-semibold`}>
                {toTier.name}
              </Badge>
            </div>
          </div>

          <h2 className="text-xl font-semibold tracking-tight">
            You've unlocked {toTier.name}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">
            Clean payout #{cleanPayoutNumber} confirmed. Consistency unlocked.
          </p>
        </div>

        {/* Benefits */}
        {benefits.length > 0 && (
          <div className="px-6 py-5 space-y-3 border-b">
            {benefits.map((b) => {
              const Icon = BENEFIT_ICONS[b.icon];
              return (
                <div key={b.icon} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Icon className="h-4 w-4" />
                    <span>{b.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground line-through text-xs">{b.fromValue}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className={`font-semibold ${toStyle.text}`}>{b.toValue}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Behavioral copy */}
        <div className="px-6 py-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {copy.body}
          </p>
        </div>

        {/* CTAs */}
        <div className="px-6 pb-6 flex gap-3">
          <Button asChild className="flex-1" onClick={handleCtaClick}>
            <Link to="/trader/payouts">View My Benefits</Link>
          </Button>
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Continue to Dashboard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
