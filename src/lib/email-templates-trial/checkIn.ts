/** Day 10 of a trial: a check-in naming features that are in the app's navigation today. */
import { appLink, company, contactLine, greeting, headerSafe, list, para, trialLayout, type RenderedEmail, type TrialEmailPayload } from './shared';

/** Each path is a live page in src/components/accounting/navSections/. */
export const CHECK_IN_FEATURES: readonly { label: string; href: string; what: string }[] = [
  { label: 'Bank mapping rules', href: '/accounting/bank-reconciliation/rules', what: 'allocate repeat bank transactions for you' },
  { label: 'Recurring invoices', href: '/accounting/recurring-invoices', what: 'bill regular customers on a schedule' },
  { label: 'Quotes', href: '/accounting/customer-quotes', what: 'send a quote and turn it into an invoice' },
  { label: 'Profit and loss', href: '/accounting/reports/income-statement', what: 'see how the business is doing this month' },
  { label: 'VAT201', href: '/accounting/sars/vat201', what: 'prepare your VAT return from your books' },
];

export function renderCheckIn(p: TrialEmailPayload): RenderedEmail {
  const inner = [
    greeting(p),
    para(`You have been using IsaFlow with ${company(p)} for over a week. Here are a few things worth trying next:`),
    list(CHECK_IN_FEATURES.map((f) => `${appLink(p, f.href, f.label)}: ${f.what}.`)),
    para('If something is not working the way you expect, tell us and we will help you sort it out.'),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`How is IsaFlow working for ${p.companyName}?`), html: trialLayout(inner) };
}
