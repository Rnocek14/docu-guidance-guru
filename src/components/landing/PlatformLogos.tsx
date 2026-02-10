import { useEffect, useRef } from 'react';
import { Monitor, Upload, Plug } from 'lucide-react';
import { track } from '@/lib/track';

const platforms = [
  { icon: Upload, name: 'CSV Upload', status: 'Available' },
  { icon: Monitor, name: 'Manual Entry', status: 'Available' },
  { icon: Plug, name: 'Tradovate', status: 'Coming Soon' },
  { icon: Plug, name: 'NinjaTrader', status: 'Planned' },
];

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
          Supported Platforms
        </p>
        <div className="flex flex-wrap justify-center gap-6 md:gap-10">
          {platforms.map(({ icon: Icon, name, status }) => (
            <div key={name} className="flex items-center gap-2.5 text-sm">
              <div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center">
                <Icon className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium text-foreground">{name}</p>
                <p className="text-xs text-muted-foreground">{status}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
