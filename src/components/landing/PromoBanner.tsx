import { useState, useEffect, useRef } from 'react';
import { X, Sparkles } from 'lucide-react';
import { track } from '@/lib/track';

export function PromoBanner() {
  const [dismissed, setDismissed] = useState(false);
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('promo_view');
    }
  }, []);

  if (dismissed) return null;

  return (
    <div className="relative bg-primary/10 border-b border-primary/20">
      <div className="container mx-auto px-4 py-2.5 flex items-center justify-center gap-2 text-sm">
        <Sparkles className="h-4 w-4 text-primary shrink-0" />
        <span className="text-foreground font-medium">
          Now Open — A fair, rules-based evaluation for serious traders.
        </span>
        <a
          href="#pricing"
          onClick={() => track('promo_click')}
          className="text-primary font-semibold hover:underline underline-offset-2 ml-1"
        >
          Get Started →
        </a>
        <button
          onClick={() => { setDismissed(true); track('promo_dismiss'); }}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss banner"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
