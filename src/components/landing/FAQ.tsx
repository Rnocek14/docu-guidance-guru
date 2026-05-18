import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const faqs = [
  {
    q: 'Is this real trading?',
    a: 'No. All trading activity takes place in a simulated environment. There is no real capital at risk. Payouts are performance-based rewards funded from program revenue.',
  },
  {
    q: 'How do payouts work?',
    a: 'Once you pass the evaluation and meet the payout eligibility requirements (minimum trading days, profit buffer, cooling period), you can request a payout. Requests are reviewed by staff before any action is taken.',
  },
  {
    q: 'What happens if I breach a rule?',
    a: 'The system detects the breach and flags it for staff review. A risk officer reviews the situation and makes the final call.',
  },
  {
    q: 'Can rules change during my challenge?',
    a: "Your rules are published at the time of purchase and versioned. We don\u2019t change them mid-challenge.",
  },
  {
    q: 'What trading platforms can I use?',
    a: 'Currently we support manual trade entry and CSV uploads. Direct broker integration (starting with Tradovate) is coming soon.',
  },
  {
    q: 'What is the reset fee?',
    a: 'If you breach your account and want to try again, you can reset for $99. This gives you a fresh account with the same published rules and tier.',
  },
  {
    q: 'What is the lifetime payout limit?',
    a: 'Each tier has a maximum lifetime earnings amount, expressed as a multiple of your entry fee (e.g., up to 10\u00D7 on the Starter tier and 7\u00D7 on the Founder\u2019s Edition). This is disclosed on the pricing page before purchase.',
  },
  {
    q: 'How fast are payouts processed?',
    a: 'Payout requests are typically reviewed within 3\u20135 business days. Once approved, payment is usually processed within 1\u20135 business days depending on your payout method.',
  },
  {
    q: 'When can I request rewards?',
    a: 'Your first payout becomes eligible 7 days after entering the Performance phase. Subsequent payouts follow a 14-day cooldown, plus the minimum trading days, winning days, and profit buffer requirements. Full details are on the Rules page.',
  },
  {
    q: 'Why are there caps?',
    a: 'Lifetime caps help the platform maintain the reserves needed to pay approved requests reliably. Cap amounts are disclosed on the pricing page before you buy.',
  },
];

export function FAQ() {
  return (
    <section className="py-20 lg:py-28 border-t border-border">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">Frequently Asked Questions</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Straight answers. No fine print.
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Accordion type="single" collapsible className="space-y-2">
            {faqs.map((faq, i) => (
              <AccordionItem
                key={i}
                value={`faq-${i}`}
                className="border border-border rounded-lg px-6 data-[state=open]:bg-card/50"
              >
                <AccordionTrigger className="text-left text-base font-medium hover:no-underline py-4">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-sm leading-relaxed pb-4">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}
