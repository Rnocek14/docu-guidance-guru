import wealthChartsLogoDark from '@/assets/wealthcharts-logo.svg';
import wealthChartsLogoLight from '@/assets/wealthcharts-logo-light.svg';

/**
 * Sub-hero credibility row. Borrowed-trust signal placed directly under the
 * hero so it lands in the first impression without competing with the
 * Meridian wordmark in the headline. Intentionally minimal — grayscale,
 * quiet, enterprise-SaaS style. See mem://design/payout-copy-honesty for
 * tone reference.
 */
export function HeroCredibility() {
  return (
    <section className="border-t border-border/40 bg-background/40">
      <div className="container mx-auto px-4 py-7">
        <div className="flex items-center justify-center gap-4 opacity-85 hover:opacity-100 transition-opacity">
          <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-medium">
            Charts powered by
          </span>
          <img
            src={wealthChartsLogoLight}
            alt="WealthCharts"
            className="h-7 md:h-8 w-auto block dark:hidden"
          />
          <img
            src={wealthChartsLogoDark}
            alt="WealthCharts"
            className="h-7 md:h-8 w-auto hidden dark:block"
          />
        </div>
      </div>
    </section>
  );
}