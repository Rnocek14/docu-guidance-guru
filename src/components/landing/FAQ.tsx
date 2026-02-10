import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const faqs = [
  {
    q: 'Is this real trading?',
    a: 'No. All trading activity takes place in a simulated environment. There is no real capital at risk. Payouts are performance-based rewards for meeting evaluation criteria.',
  },
  {
    q: 'How do payouts work?',
    a: 'Once you pass the evaluation and meet the payout eligibility requirements (minimum trading days, profit buffer, cooling period), you can request a payout. Payout requests are reviewed by a human — not auto-denied.',
  },
  {
    q: 'What happens if I breach a rule?',
    a: 'The system detects the breach and flags it for human review. Accounts are not auto-failed. A risk officer reviews the situation and makes the final call.',
  },
  {
    q: 'Can rules change during my challenge?',
    a: 'No. Your rules are frozen at the moment you purchase your evaluation. They cannot be changed mid-challenge. This is a core commitment.',
  },
  {
    q: 'What trading platforms can I use?',
    a: 'Currently we support manual trade entry and CSV uploads. Direct broker integration (starting with Tradovate) is coming soon.',
  },
  {
    q: 'What is the reset fee?',
    a: 'If you breach your account and want to try again, you can reset for $99. This gives you a fresh account with the same rules and tier.',
  },
  {
    q: 'What is the lifetime payout limit?',
    a: 'Each tier has a maximum lifetime earnings amount, expressed as a multiple of your entry fee (e.g., up to 7× on the Starter tier). This is disclosed upfront before purchase and ensures the platform can reliably pay approved requests.',
  },
  {
    q: 'How fast are payouts processed?',
    a: 'Payout requests are typically reviewed within 3–5 business days. Once approved, payment is usually processed within 1–5 business days depending on your payout method.',
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
