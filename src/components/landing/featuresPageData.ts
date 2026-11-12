/**
 * Copy for /features. Every line maps to something shipped: PRICING_TIERS and
 * BUREAU_SKUS (pricingData.ts, landingData.ts), CLOSE_AGENT_ADDON, faqData.ts and
 * content/help/{getting-started-for-a-bureau,preparing-sars-returns-for-efiling,running-payroll}.md.
 * FEATURES.md is stale: do not use it as a source.
 */
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, Building2, CalendarCheck, LayoutDashboard, UserCog, Users } from 'lucide-react';

export interface FeatureCard {
  icon?: LucideIcon;
  title: string;
  body: string;
}

export const BUREAU_FEATURES: FeatureCard[] = [
  {
    icon: LayoutDashboard,
    title: 'One dashboard across your clients',
    body: 'The bureau dashboard lists the work owed across your client companies, most urgent first.',
  },
  {
    icon: Building2,
    title: 'Every client is its own company',
    body: 'Each client has its own ledger, payroll and VAT. Link client companies to your bureau and move between them.',
  },
  {
    icon: Users,
    title: 'Payroll for many clients',
    body: "Run PAYE, UIF and SDL for each client, issue payslips and post the payroll journal to that client's ledger.",
  },
  {
    icon: UserCog,
    title: 'Your team, with roles',
    body: 'Give each staff member their own login and invite them to the client companies they work on. Roles are owner, admin, manager and viewer.',
  },
  {
    icon: CalendarCheck,
    title: 'Compliance calendar',
    body: 'A compliance calendar sits in your cockpit beside your client list.',
  },
  {
    icon: ArrowRightLeft,
    title: 'Bring each client across',
    body: 'Migration tools for Sage, Xero, QuickBooks and Pastel exports bring over the chart of accounts, customers, suppliers and opening balances, with a balance check before anything is posted.',
  },
];

export const SARS_FEATURES: FeatureCard[] = [
  {
    title: 'VAT201',
    body: 'IsaFlow calculates VAT on every transaction and prepares your VAT201 figures for each period. It flags problems before you file and can lock a period once you have filed.',
  },
  {
    title: 'EMP201',
    body: 'Prepared from your approved pay runs, with PAYE, UIF, SDL and the ETI offset, ready to file on eFiling.',
  },
  {
    title: 'EMP501 and IRP5/IT3(a)',
    body: 'Prepared for you to submit through e@syFile Employer.',
  },
];

export const MORE_FEATURES: string[] = [
  'Purchases and supplier invoices (Business plan and above)',
  'Inventory: products and stock levels (Business plan and above)',
  'Multi-currency and exchange rates (Business plan and above)',
  'AI document capture and smart categorisation (Business plan and above)',
  'Fixed assets, budgets and financial reports',
  'Group consolidation and annual financial statements (Premium plan)',
  'Approval workflows and cost centres (Premium plan)',
  'Close Agent add-on: prepares month-end entries for you to approve',
  'Two-factor authentication, permissions by module and a field-level audit trail',
  'Application and database servers hosted in South Africa',
];
