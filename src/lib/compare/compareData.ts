/**
 * Content for /compare/{sage,xero,quickbooks,simplepay,payspace}. Rules: plain short sentences, no
 * competitor prices, no invented numbers. Claims about competitors stay general
 * and tell the reader to check the vendor. Claims about IsaFlow match the product.
 * SimplePay and PaySpace are payroll products: those two pages compare payroll only.
 */
import type { FaqEntry } from '@/lib/seo/faqSchema';

export interface CompareRow {
  topic: string;
  isaflow: string;
  other: string;
}

export interface CompareEntry {
  slug: 'sage' | 'xero' | 'quickbooks' | 'simplepay' | 'payspace';
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
  isaflow: 'Fixed assets, budgets and financial reports are part of the product. Annual financial statements are on the Premium plan.',
  other: 'Check what is in your plan and what needs an add-on or app.',
};

const VENDOR_SITE = "See the vendor's own site for current details.";

// IsaFlow payroll facts: faqData.ts, content/help/running-payroll.md,
// content/help/getting-started-for-a-bureau.md and PAYROLL_ADDON in pricingData.ts.
const PAYROLL_COMPARE_ROWS: CompareRow[] = [
  { topic: 'What it is', isaflow: 'Accounting and payroll in one product. Payroll is an add-on.', other: 'A payroll product. Check which accounting software it works with.' },
  { topic: 'PAYE, UIF and SDL', isaflow: 'Calculated on each pay run from versioned SARS tax tables, with ETI where it is set up.', other: VENDOR_SITE },
  { topic: 'Payslips', isaflow: 'Produced from each pay run.', other: VENDOR_SITE },
  { topic: 'EMP201, EMP501 and IRP5/IT3(a)', isaflow: 'Prepares EMP201 for you to file on eFiling, and EMP501 and IRP5/IT3(a) for you to submit through e@syFile Employer.', other: 'Check which SARS returns and files your plan prepares.' },
  { topic: 'Payroll journal', isaflow: 'Approving a pay run posts the payroll journal to the general ledger in the same product.', other: 'Check how payroll journals reach your accounting software.' },
  { topic: 'Bureaus and practices', isaflow: 'Each client is its own company with its own ledger, payroll and VAT. One bureau dashboard lists the work owed across your clients.', other: 'Check what the vendor offers for bureaus and accountants.' },
  { topic: 'Pricing', isaflow: 'Payroll is priced per active employee per month. See the pricing page.', other: "See the vendor's own pricing page." },
  { topic: 'Moving over', isaflow: 'Employees and year-to-date figures are not imported. You set up employees and pay packages in IsaFlow.', other: 'Not applicable. You already use it.' },
];

const PAYROLL_ISAFLOW_STRENGTHS = [
  'Payroll and accounting in one product: approving a pay run posts the payroll journal to your general ledger.',
  'EMP201 is prepared for eFiling, and EMP501 and IRP5/IT3(a) for e@syFile Employer, next to your VAT201.',
  'Built for bureaus and practices: each client is its own company, with one bureau dashboard across all of them.',
  'Plans are priced in rand, with a 30-day free trial.',
];

const payrollSwitching = (name: string): string =>
  `IsaFlow does not import employees or year-to-date payroll figures from ${name}. You add employees and pay packages in IsaFlow. We suggest that your first IsaFlow pay run is March, the start of the tax year. Before you switch, run one month in both systems and compare gross pay, PAYE, UIF, SDL and net pay.`;

const PAYROLL_FAQ_COMMON = [
  { q: 'Does IsaFlow handle PAYE, UIF and SDL?', a: 'Yes. IsaFlow payroll calculates PAYE, UIF and SDL, produces payslips, and prepares EMP201 and IRP5 data. It is an add-on priced per active employee per month.' },
  { q: 'How do I file EMP201 and IRP5 from IsaFlow?', a: 'IsaFlow prepares EMP201 for you to file on SARS eFiling, and EMP501 and IRP5/IT3(a) for you to submit through e@syFile Employer. You do the filing yourself.' },
];

const payrollMoveFaq = (name: string) => ({
  q: `Can I move my payroll from ${name} to IsaFlow?`,
  a: 'Yes. IsaFlow does not import employees or year-to-date figures, so you set up employees and pay packages in IsaFlow. We suggest starting with the March pay run, the start of the tax year, and comparing one month in both systems first.',
});

export const COMPARE_ENTRIES: CompareEntry[] = [
  {
    slug: 'sage',
    name: 'Sage',
    product: 'Sage Business Cloud Accounting',
    title: 'IsaFlow vs Sage Business Cloud Accounting: South Africa Comparison',
    description: 'A plain-language comparison of IsaFlow and Sage Business Cloud Accounting for South African businesses: VAT201, payroll, bank reconciliation and switching.',
    intro: 'Sage is one of the best-known accounting brands in South Africa. Many accountants and bookkeepers already know it. IsaFlow is a newer cloud product built for South African VAT, payroll and reporting. This page explains how they differ so you can choose.',
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
      'Plans are priced in rand, with a 30-day free trial.',
      'AI bank matching is built in, and AI document capture is on the Business plan and above.',
    ],
    switching: 'IsaFlow includes a migration wizard for Sage exports. It maps your chart of accounts and brings over customers, suppliers and opening balances. It checks that the balances agree before anything is posted. Run it in the free trial first and compare the numbers with your Sage reports.',
    faq: [
      { q: 'Can I move from Sage to IsaFlow?', a: 'Yes. IsaFlow has a migration tool for Sage exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does IsaFlow do VAT201 like Sage?', a: 'IsaFlow prepares VAT201 figures for each VAT period and flags problems before you file. You capture the return on SARS eFiling yourself.' },
      { q: 'Is IsaFlow cheaper than Sage?', a: 'Our prices are on the pricing page. Check Sage\'s current pricing and add-ons, then compare the total for the features you need.' },
      { q: 'What does Sage do better than IsaFlow?', a: 'Sage has a longer history in South Africa, a larger user base and more accountants who already use it. If your accountant works only in Sage, that matters.' },
    ],
  },
  {
    slug: 'xero',
    name: 'Xero',
    product: 'Xero',
    title: 'IsaFlow vs Xero: Accounting Software Comparison for South Africa',
    description: 'How IsaFlow and Xero compare for South African businesses: VAT201 preparation, payroll, bank reconciliation, app ecosystem and switching.',
    intro: 'Xero is a global cloud accounting product with a large app marketplace. IsaFlow is built for South African businesses first. This page sets out the differences in plain terms.',
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
      'South African VAT201, EMP201 and payroll tax are the core design.',
      'Plans are priced in rand, with a 30-day free trial.',
      'AI bank matching is built in, and AI document capture is on the Business plan and above.',
    ],
    switching: 'IsaFlow includes a migration tool for Xero exports. It maps your chart of accounts and brings over customers, suppliers and opening balances, then checks the balances. Try it in the free trial and compare your trial balance with Xero.',
    faq: [
      { q: 'Can I move from Xero to IsaFlow?', a: 'Yes. IsaFlow has a migration tool for Xero exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does IsaFlow import bank statements like Xero?', a: 'IsaFlow imports bank statements in CSV, OFX, QFX, QIF, MT940 and PDF for reconciliation.' },
      { q: 'Is IsaFlow built for South African tax?', a: 'Yes. IsaFlow prepares VAT201 and EMP201 for you to file on SARS eFiling, and EMP501 and IRP5 information for you to submit through e@syFile Employer.' },
      { q: 'What does Xero do better than IsaFlow?', a: 'Xero has a much larger app marketplace and works across many countries. If you need a specific connected app, check that it exists for IsaFlow.' },
    ],
  },
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    product: 'QuickBooks Online',
    title: 'IsaFlow vs QuickBooks Online: South Africa Accounting Comparison',
    description: 'A fair comparison of IsaFlow and QuickBooks Online for South African businesses: VAT201, payroll, bank reconciliation, reports and how to switch.',
    intro: 'QuickBooks Online is a widely used cloud accounting product from Intuit, available in South Africa. IsaFlow is built around South African tax and payroll. This page lists the differences in plain language.',
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
      'Plans are priced in rand, with a 30-day free trial.',
      'AI bank matching is built in, and AI document capture is on the Business plan and above.',
    ],
    switching: 'IsaFlow includes a migration tool for QuickBooks exports. It maps your chart of accounts and brings over customers, suppliers and opening balances, then checks the balances. Run it during the free trial and compare reports before you switch.',
    faq: [
      { q: 'Can I move from QuickBooks to IsaFlow?', a: 'Yes. IsaFlow has a migration tool for QuickBooks exports. It brings over your chart of accounts, customers, suppliers and opening balances, and checks the balances before posting.' },
      { q: 'Does IsaFlow handle South African payroll?', a: 'Yes. IsaFlow payroll calculates PAYE, UIF and SDL and prepares payslips plus EMP201 and IRP5 data. It is an add-on priced per active employee.' },
      { q: 'Does IsaFlow prepare VAT201?', a: 'Yes. IsaFlow prepares VAT201 figures for each VAT period and flags problems before you file. You capture the return on SARS eFiling yourself.' },
      { q: 'What does QuickBooks do better than IsaFlow?', a: 'QuickBooks is a larger international brand with more integrations and mobile apps. If you rely on a particular integration, check that IsaFlow supports it.' },
    ],
  },
  {
    slug: 'simplepay',
    name: 'SimplePay',
    product: 'SimplePay',
    title: 'IsaFlow vs SimplePay: Payroll Software Comparison for South Africa',
    description: 'How IsaFlow payroll and SimplePay compare for South African employers, practices and bureaus: PAYE, UIF and SDL, payslips, EMP201, IRP5 and switching.',
    intro: 'SimplePay is a South African cloud payroll product. IsaFlow is accounting software with payroll built in, so pay runs and the books live in one place. This page compares payroll only, in plain terms, so you can choose.',
    rows: PAYROLL_COMPARE_ROWS,
    otherStrengths: [
      'A dedicated payroll product: payroll is its whole focus.',
      'It may be all you need if you only want payroll and are happy with your current accounting software.',
      'If you rely on a particular payroll feature, check its site and check that IsaFlow has it before you move.',
    ],
    isaflowStrengths: PAYROLL_ISAFLOW_STRENGTHS,
    switching: payrollSwitching('SimplePay'),
    faq: [
      { q: 'Is IsaFlow a payroll product like SimplePay?', a: 'IsaFlow is accounting software with payroll built in as an add-on. SimplePay is a payroll product. If you want payroll and your books in one place, IsaFlow covers both. If you only need payroll, a payroll-only product may suit you.' },
      ...PAYROLL_FAQ_COMMON,
      payrollMoveFaq('SimplePay'),
      { q: 'What does SimplePay do better than IsaFlow?', a: 'SimplePay is a dedicated payroll product, so payroll is its whole focus. Check its site for features you need, and compare the total cost for your number of employees.' },
    ],
  },
  {
    slug: 'payspace',
    name: 'PaySpace',
    product: 'PaySpace',
    title: 'IsaFlow vs PaySpace: Payroll Software Comparison for South Africa',
    description: 'How IsaFlow payroll and PaySpace compare for South African employers, practices and bureaus: PAYE, UIF and SDL, payslips, EMP201, IRP5 and switching.',
    intro: 'PaySpace is a cloud payroll and HR product used in South Africa. IsaFlow is accounting software with payroll built in, so pay runs and the books live in one place. This page compares payroll only, in plain terms, so you can choose.',
    rows: PAYROLL_COMPARE_ROWS,
    otherStrengths: [
      'A dedicated payroll and HR product.',
      'If you need HR tools as well as payroll, check what it offers.',
      'If you run payroll in more than one country, check which countries each product supports.',
    ],
    isaflowStrengths: PAYROLL_ISAFLOW_STRENGTHS,
    switching: payrollSwitching('PaySpace'),
    faq: [
      { q: 'Is IsaFlow a payroll product like PaySpace?', a: 'IsaFlow is accounting software with payroll built in as an add-on. PaySpace is a payroll and HR product. If you want payroll and your books in one place, IsaFlow covers both. If you need a separate payroll and HR system, a specialist product may suit you.' },
      ...PAYROLL_FAQ_COMMON,
      payrollMoveFaq('PaySpace'),
      { q: 'What does PaySpace do better than IsaFlow?', a: 'PaySpace is a dedicated payroll and HR product. Check its site for the HR and payroll features you need, and compare the total cost for your number of employees.' },
    ],
  },
];

export function getCompareEntry(slug: string): CompareEntry | undefined {
  return COMPARE_ENTRIES.find((e) => e.slug === slug);
}
