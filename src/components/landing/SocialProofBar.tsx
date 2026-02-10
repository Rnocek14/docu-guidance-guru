import { Shield, FileText, Eye, Lock, Check } from 'lucide-react';

const stats = [
  { icon: Shield, label: 'Simulated Environment', value: '100%' },
  { icon: FileText, label: 'Audit Trail Coverage', value: 'Every Trade' },
  { icon: Eye, label: 'Human-Reviewed Decisions', value: '100%' },
  { icon: Lock, label: 'Rules Changed Mid-Eval', value: 'Never' },
];

export function SocialProofBar() {
  return (
    <section className="py-8 border-t border-border bg-card/40">
      <div className="container mx-auto px-4">
        <div className="flex flex-wrap justify-center gap-8 md:gap-14">
          {stats.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-3">
              <Icon className="h-5 w-5 text-primary" />
              <div>
                <p className="text-lg font-bold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
