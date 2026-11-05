/**
 * Homepage FAQ. The visible accordion and the FAQPage JSON-LD both render this
 * array, so the schema always matches the page. Only state what the product does.
 */
import type { FAQItem } from './landingData';

export const FAQ_ITEMS: FAQItem[] = [
  {
    q: 'What is IsaFlow?',
    a: 'IsaFlow is cloud accounting software for South African businesses. It covers invoicing and quotes, bank statement import and reconciliation, VAT201 preparation, payroll, fixed assets, budgets and financial reports. Higher plans add AI document capture and annual financial statements. It runs in your browser and is built around South African VAT, payroll tax and reporting rules.',
  },
  {
    q: 'Can I try IsaFlow for free?',
    a: 'Yes. Every plan comes with a 30-day free trial and no credit card is required. You get full access to the features in the plan you pick, so you can test IsaFlow with your own data before you commit.',
  },
  {
    q: 'Does IsaFlow prepare my VAT201 return?',
    a: 'Yes. IsaFlow calculates VAT on every transaction and prepares your VAT201 figures for each VAT period. It flags problems before you file, such as transactions with missing VAT details, and it can lock a period once you have filed so later postings do not change the filed numbers.',
  },
  {
    q: 'What does IsaFlow prepare for SARS eFiling?',
    a: 'IsaFlow prepares VAT201 and EMP201 for you to file on eFiling, and EMP501 and IRP5/IT3(a) for you to submit through e@syFile Employer.',
  },
  {
    q: 'Does IsaFlow handle payroll, PAYE, UIF and SDL?',
    a: 'Yes. Payroll calculates PAYE, UIF and SDL, produces payslips, and prepares EMP201 and IRP5 data. Payroll is an add-on that is priced per active employee per month. See the pricing page for the current price.',
  },
  {
    q: 'Can I switch from Sage, Xero, QuickBooks or Pastel?',
    a: 'Yes. IsaFlow has migration tools for Sage, Xero, QuickBooks and Pastel exports. You can bring over your chart of accounts, customers, suppliers and opening balances, with account mapping and a balance check before anything is posted.',
  },
  {
    q: 'Does IsaFlow support bank statement import and reconciliation?',
    a: 'IsaFlow reconciles your bank accounts by importing statements in CSV, OFX, QFX, QIF, MT940 and PDF formats, then matching transactions with rules, references, amounts, dates and AI suggestions.',
  },
  {
    q: 'Where is my data stored, and is IsaFlow POPIA compliant?',
    a: 'Our application and database servers are hosted in South Africa. We handle personal information under the Protection of Personal Information Act (POPIA), as set out in our privacy policy. Where a service provider processes information outside South Africa, we transfer it only where POPIA allows.',
  },
  {
    q: 'Is my data secure?',
    a: 'IsaFlow supports two-factor authentication (TOTP), permissions by module, masked bank account numbers on screen, encrypted connections (SSL/TLS), hashed passwords and a field-level audit trail on financial records.',
  },
  {
    q: 'How does IsaFlow compare with Sage, Xero and QuickBooks?',
    a: 'IsaFlow is built for South African businesses, with VAT201 and EMP201 preparation and payroll tax in the same product. The established products have bigger app marketplaces and more accountants who already know them. Our comparison pages explain the differences in plain language so you can decide what fits your business.',
  },
];
