/**
 * Homepage FAQ. The visible accordion and the FAQPage JSON-LD both render this
 * array, so the schema always matches the page. Only state what the product does.
 */
import type { FAQItem } from './landingData';

export const FAQ_ITEMS: FAQItem[] = [
  {
    q: 'What is ISAFlow?',
    a: 'ISAFlow is cloud accounting software for South African businesses. It covers invoicing and quotes, bank reconciliation, VAT201 and other SARS compliance, payroll, fixed assets, budgets and financial reports. Higher plans add AI document capture and annual financial statements. It runs in your browser and is built around South African VAT, payroll tax and reporting rules.',
  },
  {
    q: 'Can I try ISAFlow for free?',
    a: 'Yes. Every plan comes with a 30-day free trial and no credit card is required. You get full access to the features in the plan you pick, so you can test ISAFlow with your own data before you commit.',
  },
  {
    q: 'Does ISAFlow prepare my VAT201 return?',
    a: 'Yes. ISAFlow calculates VAT on every transaction and prepares your VAT201 figures for each VAT period. It flags problems before you file, such as transactions with missing VAT details, and it can lock a period once you have filed so later postings do not change the filed numbers.',
  },
  {
    q: 'Can I file with SARS eFiling from ISAFlow?',
    a: 'ISAFlow prepares the VAT201 and EMP201 figures and keeps a record of each submission and its status. You still capture the return on SARS eFiling yourself. Direct submission to SARS from inside ISAFlow is not something we rely on today.',
  },
  {
    q: 'Does ISAFlow handle payroll, PAYE, UIF and SDL?',
    a: 'Yes. Payroll calculates PAYE, UIF and SDL, produces payslips, and prepares EMP201 and IRP5 data. Payroll is an add-on that is priced per active employee per month. See the pricing page for the current price.',
  },
  {
    q: 'Can I switch from Sage, Xero, QuickBooks or Pastel?',
    a: 'Yes. ISAFlow has migration tools for Sage, Xero, QuickBooks and Pastel exports. You can bring over your chart of accounts, customers, suppliers and opening balances, with account mapping and a balance check before anything is posted.',
  },
  {
    q: 'Does ISAFlow support bank feeds and bank reconciliation?',
    a: 'ISAFlow reconciles your bank accounts by importing statements in CSV, OFX, QFX, QIF, MT940 and PDF formats, then matching transactions with rules, references, amounts, dates and AI suggestions. For ABSA there is also a browser import that works from your own signed-in bank session. We do not offer a live direct feed from every bank.',
  },
  {
    q: 'Where is my data stored, and is ISAFlow POPIA compliant?',
    a: 'Our application and database servers are hosted in South Africa. We handle personal information under the Protection of Personal Information Act (POPIA), as set out in our privacy policy. Where a service provider processes information outside South Africa, we transfer it only where POPIA allows.',
  },
  {
    q: 'Is my data secure?',
    a: 'ISAFlow supports two-factor authentication (TOTP), permissions by module, masked bank account numbers on screen, encrypted connections (SSL/TLS), hashed passwords and a field-level audit trail on financial records.',
  },
  {
    q: 'How does ISAFlow compare with Sage, Xero and QuickBooks?',
    a: 'ISAFlow is built for South African businesses, with VAT201, EMP201 and payroll tax in the same product. The established products have bigger app marketplaces and more accountants who already know them. Our comparison pages explain the differences in plain language so you can decide what fits your business.',
  },
];
