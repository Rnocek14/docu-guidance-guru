import { useEffect, useRef } from 'react';
import { track } from '@/lib/track';
import wealthChartsLogoDark from '@/assets/wealthcharts-logo.svg';
import wealthChartsLogoLight from '@/assets/wealthcharts-logo-light.svg';

export function PlatformLogos() {
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('platform_logos_view');
    }
  }, []);

  return (
    <section className="py-12 border-t border-border">
      <div className="container mx-auto px-4">
        <p className="text-center text-sm text-muted-foreground mb-6 font-medium uppercase tracking-wider">
          Supported Platform
        </p>
        <div className="flex justify-center">
          <img
            src={wealthChartsLogoLight}
            alt="WealthCharts"
            className="h-10 md:h-12 w-auto opacity-90 block dark:hidden"
          />
          <img
            src={wealthChartsLogoDark}
            alt="WealthCharts"
            className="h-10 md:h-12 w-auto opacity-90 hidden dark:block"
          />
        </div>
      </div>
    </section>
  );
}
