import { Shield, FileText, Eye, Lock } from 'lucide-react';

const stats = [
  { icon: Shield, label: 'Simulated Environment', value: 'Fully Sim' },
  { icon: FileText, label: 'Key Decisions', value: 'Audit Logged' },
  { icon: Eye, label: 'Flag Reviews', value: 'By Staff' },
  { icon: Lock, label: 'Rules at Purchase', value: 'Locked' },
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
