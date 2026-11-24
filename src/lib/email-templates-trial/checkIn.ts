/** Day 10 of a trial: a service check-in (how it is going, where to get help, the setup checklist). */
import { appLink, company, contactLine, greeting, headerSafe, list, para, trialLayout, type RenderedEmail, type TrialEmailPayload } from './shared';

/** Where things are in the account. Each path is a live page in src/components/accounting/navSections/. */
export const CHECK_IN_LINKS: readonly { label: string; href: string }[] = [
  { label: 'Bank mapping rules', href: '/accounting/bank-reconciliation/rules' },
  { label: 'Recurring invoices', href: '/accounting/recurring-invoices' },
  { label: 'Quotes', href: '/accounting/customer-quotes' },
  { label: 'Profit and loss', href: '/accounting/reports/income-statement' },
  { label: 'VAT201', href: '/accounting/sars/vat201' },
];

export function renderCheckIn(p: TrialEmailPayload): RenderedEmail {
  const inner = [
    greeting(p),
    para(`You have been using IsaFlow with ${company(p)} for over a week, so we are checking in to see how your trial is going.`),
    para(`Your setup checklist on the ${appLink(p, '/accounting', 'IsaFlow dashboard')} shows what is left to set up.`),
    para('Where to find things:'),
    list(CHECK_IN_LINKS.map((f) => appLink(p, f.href, f.label))),
    para('If something is not working the way you expect, reply to this email and we will help you sort it out.'),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`How is your IsaFlow trial going for ${p.companyName}?`), html: trialLayout(inner) };
}
