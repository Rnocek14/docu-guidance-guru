import { useEffect, useRef } from 'react';
import { Shield, Users, Clock, Lock } from 'lucide-react';
import { track } from '@/lib/track';

const stats = [
  { icon: Users, value: 'Early Access', label: 'Platform Status', highlight: true },
  { icon: Shield, value: 'Human-Reviewed', label: 'Every Payout Decision' },
  { icon: Clock, value: '3–5 Days', label: 'Typical Review Time' },
  { icon: Lock, value: 'Frozen', label: 'Rules at Purchase' },
];

export function StatsCounter() {
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('stats_counter_view');
    }
  }, []);

  return (
    <section className="py-10 border-t border-border bg-card/40">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {stats.map(({ icon: Icon, value, label, highlight }) => (
            <div key={label} className="flex items-center gap-3 justify-center md:justify-start">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className={`text-lg font-bold ${highlight ? 'text-primary' : ''}`}>{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
