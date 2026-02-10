import { useEffect, useRef } from 'react';
import { Star, MessageSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { track } from '@/lib/track';

interface Testimonial {
  quote: string;
  name: string;
  detail: string;
  stars: number;
}

const testimonials: Testimonial[] = [
  {
    quote: "The fact that rules are locked at purchase was the reason I chose this platform. No bait-and-switch.",
    name: "Beta Tester",
    detail: "Starter Evaluation",
    stars: 5,
  },
  {
    quote: "I got flagged for a possible breach, and an actual person reviewed it. That alone sets them apart.",
    name: "Beta Tester",
    detail: "Evaluation Phase",
    stars: 5,
  },
  {
    quote: "Knowing exactly what I can earn before I pay anything — that transparency matters to me.",
    name: "Beta Tester",
    detail: "Pre-launch Feedback",
    stars: 4,
  },
];

export function Testimonials() {
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      track('testimonial_view');
    }
  }, []);

  return (
    <section className="py-20 lg:py-28 border-t border-border bg-card/30">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 text-sm text-muted-foreground mb-4">
            <MessageSquare className="h-4 w-4" />
            Beta Feedback (Anonymized)
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">What Early Testers Say</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Real feedback from our beta testing phase.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {testimonials.map((t, i) => (
            <Card key={i} className="border-border bg-card/60">
              <CardContent className="p-6">
                <div className="flex gap-0.5 mb-3">
                  {Array.from({ length: 5 }).map((_, s) => (
                    <Star
                      key={s}
                      className={`h-4 w-4 ${s < t.stars ? 'text-primary fill-primary' : 'text-muted'}`}
                    />
                  ))}
                </div>
                <p className="text-sm text-foreground leading-relaxed mb-4">
                  "{t.quote}"
                </p>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t.name}</span>
                  <span className="mx-1.5">·</span>
                  {t.detail}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
