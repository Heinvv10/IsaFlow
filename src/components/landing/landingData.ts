/**
 * Landing page static data arrays.
 * Separated to keep page shell and section components lean.
 */

import {
  FileText, RefreshCw, Shield, Zap,
  Receipt, Landmark, Brain,
  Check, Star,
} from 'lucide-react';

export { Check, Star };

export const APP_URL = 'https://app.isaflow.co.za';

export const STATS = [
  { value: 'R 2.4B+', label: 'Transactions Processed' },
  { value: '500+', label: 'Businesses' },
  { value: '30+', label: 'Financial Reports' },
];

export const TRUST_COMPANIES = [
  'TechBridge Solutions',
  'VDM Construction',
  'Naidoo & Associates',
  'Bright Sphere',
  'SA Retail Group',
];

export const FEATURE_PILLARS = [
  {
    icon: FileText,
    title: 'Get paid faster',
    desc: 'Professional invoices, automated reminders, real-time AR tracking.',
  },
  {
    icon: RefreshCw,
    title: 'Always reconciled',
    desc: 'Connect your bank, match transactions automatically, close your books with confidence.',
  },
  {
    icon: Shield,
    title: 'Stay compliant',
    desc: 'VAT returns, tax submissions and audit trails — handled.',
  },
  {
    icon: Zap,
    title: 'Work smarter',
    desc: 'AI document capture, smart categorisation, anomaly detection.',
  },
];

export const DETAILED_FEATURES = [
  {
    badge: 'Accounts Receivable',
    title: 'Get paid faster with smart invoicing',
    desc: 'Create professional invoices, set up recurring billing, and track every payment. Automated reminders keep your cash flow healthy while the customer portal gives clients self-service access.',
    bullets: [
      'Professional invoice PDF generation & email delivery',
      'Quotes → Sales Orders → Invoices workflow',
      'Recurring invoices with flexible schedules',
      'Credit notes, write-offs & payment allocation',
      'Customer statements & batch statement runs',
      'AR aging analysis with debtors manager dashboard',
    ],
    imgKey: 'invoicing',
  },
  {
    badge: 'Banking',
    title: 'Bank reconciliation on autopilot',
    desc: 'Import statements from your bank or connect live bank feeds. Our 4-tier smart matching engine automatically categorises and reconciles transactions with confidence scoring.',
    bullets: [
      '7+ bank statement formats supported',
      '4-tier auto-matching (rules → reference → amount+date → AI)',
      'AI-powered smart categorisation with anomaly detection',
      'Categorisation rules engine with live preview',
      'Live bank feeds for real-time sync',
      'Batch payments with EFT file generation',
    ],
    imgKey: 'banking',
  },
  {
    badge: 'AI-Powered',
    title: 'Intelligence built into every workflow',
    desc: 'ISAFlow uses Vision AI and machine learning to automate tedious accounting tasks. Capture a receipt and watch it become a journal entry in seconds.',
    bullets: [
      'Vision AI document extraction (receipts, invoices, contracts)',
      'Auto-invoice creation from captured documents',
      '3-way matching: PO + delivery note + invoice',
      'AI-generated management commentary on financials',
      'Natural language queries against your data',
      'Continuous close automation with smart categorisation',
    ],
    imgKey: 'ai-features',
  },
];

export const PRICING_TIERS = [
  {
    name: 'Starter',
    price: 'R 499',
    period: '/month',
    desc: 'Perfect for sole proprietors and small businesses just getting started.',
    features: [
      'Full General Ledger',
      'Invoicing, Quotes & Statements',
      'Bank Reconciliation (1 bank)',
      'VAT Returns & Tax Compliance',
      '10 Financial Reports',
      'Inventory & Items',
      'Full Audit Trail',
      'Two-Factor Authentication',
      'Customer Statements & Dunning',
      'Year-End Close Wizard',
      'Up to 2 users',
      'Email support',
    ],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Professional',
    price: 'R 999',
    period: '/month',
    desc: 'For growing businesses that need full accounting power and automation.',
    features: [
      'Everything in Starter, plus:',
      'Unlimited bank accounts & bank feeds',
      'AI Smart Categorisation & Anomaly Detection',
      'AI Document Capture (Vision AI)',
      'Recurring Invoices & Journals',
      'Batch Payments & EFT Generation',
      'All 30+ Reports & Executive Dashboard',
      'Custom Report Builder',
      'Customer Portal',
      'Fixed Assets & Depreciation',
      'Approval Workflows',
      'Multi-Currency & Exchange Rates',
      'Time & Project Tracking',
      'Up to 10 users',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 'R 2,499',
    period: '/month',
    desc: 'For accounting firms and multi-entity businesses with advanced needs.',
    features: [
      'Everything in Professional, plus:',
      'Multi-entity / Group Consolidation',
      'Payroll with PAYE/UIF/SDL & IRP5',
      'SARS eFiling (VAT201 + EMP201)',
      'AI Management Commentary & Forecasting',
      '3-Way Forecast (P&L + BS + Cash Flow)',
      'IFRS Disclosure Note Generator',
      'CaseWare Export & Account Mapping',
      'Data Archiving & Retention Engine',
      'Webhooks for CRM Integration',
      'Cost Centres & Business Units',
      'Unlimited users',
      'Dedicated account manager',
    ],
    cta: 'Contact Sales',
    popular: false,
  },
];

export const TESTIMONIALS = [
  {
    name: 'Thandi Molefe',
    role: 'CFO',
    company: 'TechBridge Solutions',
    quote: 'ISAFlow has transformed how we handle our accounting. The bank reconciliation alone saves us 15 hours a month. The compliance features give us complete peace of mind.',
    metric: 'Saves 15 hours/month',
    stars: 5,
    featured: true,
  },
  {
    name: 'Johan van der Merwe',
    role: 'Owner',
    company: 'VDM Construction',
    quote: 'The smart categorisation learns our patterns and now auto-allocates 90% of our bank transactions. Incredible time saver.',
    stars: 5,
    featured: false,
  },
  {
    name: 'Priya Naidoo',
    role: 'Practice Manager',
    company: 'Naidoo & Associates',
    quote: 'Managing multiple client entities is effortless. The approval workflows and audit trail give our clients confidence in our processes.',
    stars: 5,
    featured: false,
  },
];

export const FAQ_ITEMS = [
  {
    q: 'Can I try ISAFlow for free?',
    a: 'Yes. Every plan comes with a 14-day free trial — no credit card required. You get full access to all features in your selected tier so you can evaluate ISAFlow with your real data before committing.',
  },
  {
    q: 'Can I import data from other software?',
    a: 'Absolutely. ISAFlow includes dedicated migration wizards for Sage, Xero, QuickBooks, and Pastel. Import your chart of accounts, customers, suppliers, and opening balances with automatic account mapping and balance verification.',
  },
  {
    q: 'Which banks are supported for statement import?',
    a: 'ISAFlow supports statement imports from major banks in CSV and PDF formats, plus OFX and QIF for others. Live bank feeds provide automatic transaction syncing. Our AI auto-detects the bank format.',
  },
  {
    q: 'Is my data secure?',
    a: 'Enterprise-grade security: two-factor authentication (TOTP + backup codes), granular module-level permissions, field masking for sensitive data, SSL/TLS encryption, bcrypt password hashing, and signed JWT sessions.',
  },
  {
    q: 'Does it handle tax compliance?',
    a: 'Yes. ISAFlow supports VAT calculations on every transaction, generates VAT returns, handles payroll tax submissions, and maintains a field-level audit trail on every financial record. Full compliance out of the box.',
  },
];
