/**
 * Content for /compare/{sage,xero,quickbooks}. Rules: plain short sentences, no
 * competitor prices, no invented numbers. Claims about competitors stay general
 * and tell the reader to check the vendor. Claims about IsaFlow match the product.
 */
import type { FaqEntry } from '@/lib/seo/faqSchema';

export interface CompareRow {
  topic: string;
  isaflow: string;
  other: string;
}

export interface CompareEntry {
  slug: 'sage' | 'xero' | 'quickbooks';
  /** Short brand name used in headings. */
  name: string;
  /** Full product name. */
  product: string;
  title: string;
  description: string;
  intro: string;
  rows: CompareRow[];
  otherStrengths: string[];
  isaflowStrengths: string[];
  switching: string;
  faq: FaqEntry[];
}

const SA_TAX_ROW: CompareRow = {
  topic: 'VAT201 and SARS',
  isaflow: 'Prepares VAT201 figures, flags problems before you file, and locks filed periods.',
  other: 'Check which VAT and SARS tools your plan includes.',
};

const PAYROLL_ROW: CompareRow = {
  topic: 'Payroll (PAYE, UIF, SDL)',
  isaflow: 'Built in as an add-on, with payslips and EMP201 and IRP5 data.',
  other: 'Check whether payroll is included or sold separately.',
};

const BANK_ROW: CompareRow = {
  topic: 'Bank reconciliation',
  isaflow: 'Imports statements (CSV, OFX, QFX, QIF, MT940, PDF) and matches them with rules and AI. No live direct feed from every bank.',
  other: 'Check which South African banks offer a live feed.',
};

const FIXED_ROW: CompareRow = {
  topic: 'Fixed assets, budgets and reports',
  isaflow: 'Fixed assets, budgets and financial reports are part of the product.',
  other: 'Check what is in your plan and what needs an add-on or app.',
};

export const COMPARE_ENTRIES: CompareEntry[] = [
  {
    slug: 'sage',
    name: 'Sage',
    product: 'Sage Business Cloud Accounting',
    title: 'ISAFlow vs Sage Business Cloud Accounting: South Africa Comparison',
    description: 'A plain-language comparison of ISAFlow and Sage Business Cloud Accounting for South African businesses: VAT201, payroll, bank reconciliation and switching.',
    intro: 'Sage is one of the best-known accounting brands in South Africa. Many accountants and bookkeepers already know it. ISAFlow is a newer cloud product built for South African VAT, payroll and reporting. This page explains how they differ so you can choose.',
    rows: [
      SA_TAX_ROW, PAYROLL_ROW, BANK_ROW, FIXED_ROW,
      { topic: 'Moving over', isaflow: 'A Sage migration tool brings across accounts, customers, suppliers and opening balances.', other: 'Not applicable. You already use it.' },
    ],
    otherStrengths: [
      'A long track record and a big base of users in South Africa.',
      'Many accountants and bookkeepers already know how to use it.',
      'A wider range of connected apps and partners.',
    ],
    isaflowStrengths: [
      'VAT201, EMP201 and payroll tax sit in one South African product.',
      'Pricing is published in rand on our pricing page, with a 30-day free trial.',
      'AI document capture and AI bank matching are built in.',
    ],
    switching: 'ISAFlow includes a migration wizard for Sage exports. It maps your chart of accounts and brings over customers, suppliers and opening balances. It checks that the balances agree before anything is posted. Run it in the free trial first and compare the numbers with your Sage reports.',
    faq: [
      { q: 'Can I move from Sage to ISAFlow?', a: 'Yes. ISAFlow has a migration tool for Sage exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does ISAFlow do VAT201 like Sage?', a: 'ISAFlow prepares VAT201 figures for each VAT period and flags problems before you file. You capture the return on SARS eFiling yourself.' },
      { q: 'Is ISAFlow cheaper than Sage?', a: 'Our prices are on the pricing page. Check Sage\'s current pricing and add-ons, then compare the total for the features you need.' },
      { q: 'What does Sage do better than ISAFlow?', a: 'Sage has a longer history in South Africa, a larger user base and more accountants who already use it. If your accountant works only in Sage, that matters.' },
    ],
  },
  {
    slug: 'xero',
    name: 'Xero',
    product: 'Xero',
    title: 'ISAFlow vs Xero: Accounting Software Comparison for South Africa',
    description: 'How ISAFlow and Xero compare for South African businesses: SARS and VAT201 support, payroll, bank reconciliation, app ecosystem and switching.',
    intro: 'Xero is a global cloud accounting product with a large app marketplace. ISAFlow is built for South African businesses first. This page sets out the differences in plain terms.',
    rows: [
      SA_TAX_ROW, PAYROLL_ROW, BANK_ROW, FIXED_ROW,
      { topic: 'Moving over', isaflow: 'A Xero migration tool brings across accounts, customers, suppliers and opening balances.', other: 'Not applicable. You already use it.' },
    ],
    otherStrengths: [
      'A very large marketplace of connected apps.',
      'A global product, useful if you trade across several countries.',
      'Many accountants and bookkeepers know it well.',
    ],
    isaflowStrengths: [
      'South African VAT201, EMP201 and payroll tax are the core design, not an add-on to a global product.',
      'Rand pricing is published, with a 30-day free trial.',
      'AI document capture and AI bank matching are built in.',
    ],
    switching: 'ISAFlow includes a migration tool for Xero exports. It maps your chart of accounts and brings over customers, suppliers and opening balances, then checks the balances. Try it in the free trial and compare your trial balance with Xero.',
    faq: [
      { q: 'Can I move from Xero to ISAFlow?', a: 'Yes. ISAFlow has a migration tool for Xero exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does ISAFlow have bank feeds like Xero?', a: 'ISAFlow imports bank statements in CSV, OFX, QFX, QIF, MT940 and PDF, and has a browser import for ABSA. It does not offer a live direct feed from every bank. If a live feed is essential to you, check that before you switch.' },
      { q: 'Is ISAFlow built for South African tax?', a: 'Yes. ISAFlow is designed around VAT201, EMP201, PAYE, UIF and SDL. It prepares the figures. You file on SARS eFiling.' },
      { q: 'What does Xero do better than ISAFlow?', a: 'Xero has a much larger app marketplace and works across many countries. If you need a specific connected app, check that it exists for ISAFlow.' },
    ],
  },
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    product: 'QuickBooks Online',
    title: 'ISAFlow vs QuickBooks Online: South Africa Accounting Comparison',
    description: 'A fair comparison of ISAFlow and QuickBooks Online for South African businesses: VAT201, payroll, bank reconciliation, reports and how to switch.',
    intro: 'QuickBooks Online is a widely used cloud accounting product from Intuit, available in South Africa. ISAFlow is built around South African tax and payroll. This page lists the differences in plain language.',
    rows: [
      SA_TAX_ROW, PAYROLL_ROW, BANK_ROW, FIXED_ROW,
      { topic: 'Moving over', isaflow: 'A QuickBooks migration tool brings across accounts, customers, suppliers and opening balances.', other: 'Not applicable. You already use it.' },
    ],
    otherStrengths: [
      'A well-known global brand with mobile apps and many integrations.',
      'Many bookkeepers have used it before.',
      'Useful if you also run a business in another country.',
    ],
    isaflowStrengths: [
      'VAT201, EMP201 and payroll tax are built for South Africa.',
      'Rand pricing is published, with a 30-day free trial.',
      'AI document capture and AI bank matching are built in.',
    ],
    switching: 'ISAFlow includes a migration tool for QuickBooks exports. It maps your chart of accounts and brings over customers, suppliers and opening balances, then checks the balances. Run it during the free trial and compare reports before you switch.',
    faq: [
      { q: 'Can I move from QuickBooks to ISAFlow?', a: 'Yes. ISAFlow has a migration tool for QuickBooks exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does ISAFlow handle South African payroll?', a: 'Yes. ISAFlow payroll calculates PAYE, UIF and SDL and prepares payslips plus EMP201 and IRP5 data. It is an add-on priced per active employee.' },
      { q: 'Does ISAFlow prepare VAT201?', a: 'Yes. ISAFlow prepares VAT201 figures for each VAT period and flags problems before you file. You capture the return on SARS eFiling yourself.' },
      { q: 'What does QuickBooks do better than ISAFlow?', a: 'QuickBooks is a larger international brand with more integrations and mobile apps. If you rely on a particular integration, check that ISAFlow supports it.' },
    ],
  },
];

export function getCompareEntry(slug: string): CompareEntry | undefined {
  return COMPARE_ENTRIES.find((e) => e.slug === slug);
}
