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
    <section className="border-y border-border/40 bg-background/40">
      <div className="container mx-auto px-4 py-9">
        <div className="flex items-center justify-center gap-5">
          <span className="text-[13px] uppercase tracking-[0.22em] text-muted-foreground font-medium">
            Charts powered by
          </span>
          <img
            src={wealthChartsLogoLight}
            alt="WealthCharts"
            className="h-8 md:h-10 w-auto block dark:hidden"
          />
          <img
            src={wealthChartsLogoDark}
            alt="WealthCharts"
            className="h-8 md:h-10 w-auto hidden dark:block"
          />
        </div>
      </div>
    </section>
  );
}