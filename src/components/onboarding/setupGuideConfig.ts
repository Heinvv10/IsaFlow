/**
 * Setup Guide configuration — 9 onboarding categories with sub-tasks.
 * autoDetectKey links to API-returned completedTasks[] for automatic checking.
 */

import {
  PartyPopper,
  Building2,
  Calculator,
  Receipt,
  Landmark,
  FileText,
  Users,
  BarChart3,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

export interface SetupTask {
  id: string;
  label: string;
  description: string;
  href: string;
  autoDetectKey?: string;
}

export interface SetupCategory {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tasks: SetupTask[];
}

export const SETUP_CATEGORIES: SetupCategory[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    description: 'Get familiar with IsaFlow',
    icon: PartyPopper,
    tasks: [
      {
        id: 'welcome-video',
        label: 'Watch intro video',
        description: 'A 2-minute overview of IsaFlow features',
        href: '/accounting',
      },
      {
        id: 'welcome-demo',
        label: 'Explore demo company',
        description: 'Browse sample data to understand the workflow',
        href: '/accounting',
      },
    ],
  },
  {
    id: 'company-details',
    label: 'Company Details',
    description: 'Set up your company profile',
    icon: Building2,
    tasks: [
      {
        id: 'company-logo',
        label: 'Add company logo',
        description: 'Upload your logo for invoices and documents',
        href: '/accounting/company-settings',
        autoDetectKey: 'company-logo',
      },
      {
        id: 'company-legal',
        label: 'Set legal name & registration',
        description: 'Enter your registered company name and number',
        href: '/accounting/company-settings',
        autoDetectKey: 'company-legal',
      },
      {
        id: 'company-address',
        label: 'Add address & banking details',
        description: 'Provide physical address and bank account information',
        href: '/accounting/company-settings',
      },
    ],
  },
  {
    id: 'financial-setup',
    label: 'Financial Setup',
    description: 'Configure your financial foundation',
    icon: Calculator,
    tasks: [
      {
        id: 'chart-of-accounts',
        label: 'Review chart of accounts',
        description: 'Verify that your GL accounts are correctly set up',
        href: '/accounting/chart-of-accounts',
      },
      {
        id: 'fiscal-year',
        label: 'Set fiscal year',
        description: 'Define your financial year start and end dates',
        href: '/accounting/company-settings',
        autoDetectKey: 'fiscal-year',
      },
      {
        id: 'opening-balances',
        label: 'Enter opening balances',
        description: 'Import your starting account balances',
        href: '/accounting/opening-balances',
        autoDetectKey: 'opening-balances',
      },
    ],
  },
  {
    id: 'vat-config',
    label: 'VAT Configuration',
    description: 'Set up your tax configuration',
    icon: Receipt,
    tasks: [
      {
        id: 'vat-number',
        label: 'Set VAT registration number',
        description: 'Enter your SARS VAT registration number',
        href: '/accounting/company-settings',
        autoDetectKey: 'vat-number',
      },
      {
        id: 'vat-rates',
        label: 'Configure tax rates',
        description: 'Review and adjust VAT rates (standard 15%)',
        href: '/accounting/vat',
      },
    ],
  },
  {
    id: 'connect-bank',
    label: 'Connect Bank',
    description: 'Link your bank accounts',
    icon: Landmark,
    tasks: [
      {
        id: 'bank-account',
        label: 'Add bank account',
        description: 'Connect your business bank account to IsaFlow',
        href: '/accounting/bank-accounts',
        autoDetectKey: 'bank-account',
      },
      {
        id: 'bank-statement',
        label: 'Import first statement',
        description: 'Upload a CSV or OFX bank statement',
        href: '/accounting/bank-transactions',
        autoDetectKey: 'bank-transactions',
      },
      {
        id: 'bank-feed',
        label: 'Set up bank feed',
        description: 'Configure automatic transaction import rules',
        href: '/accounting/bank-reconciliation/rules',
      },
    ],
  },
  {
    id: 'first-invoice',
    label: 'Create First Invoice',
    description: 'Invoice your first customer',
    icon: FileText,
    tasks: [
      {
        id: 'invoice-template',
        label: 'Set up invoice template',
        description: 'Customise invoice layout, terms and numbering',
        href: '/accounting/company-settings',
      },
      {
        id: 'first-invoice-sent',
        label: 'Create and send first invoice',
        description: 'Create a customer invoice and send it',
        href: '/accounting/customer-invoices/new',
        autoDetectKey: 'customer-invoices',
      },
    ],
  },
  {
    id: 'add-contacts',
    label: 'Add Contacts',
    description: 'Add your customers and suppliers',
    icon: Users,
    tasks: [
      {
        id: 'first-customer',
        label: 'Import or create first customer',
        description: 'Add a customer to start sending invoices',
        href: '/accounting/customers/new',
        autoDetectKey: 'customers',
      },
      {
        id: 'first-supplier',
        label: 'Import or create first supplier',
        description: 'Add a supplier to track your expenses',
        href: '/accounting/suppliers/new',
        autoDetectKey: 'suppliers',
      },
    ],
  },
  {
    id: 'explore-reports',
    label: 'Explore Reports',
    description: 'View your financial position',
    icon: BarChart3,
    tasks: [
      {
        id: 'income-statement',
        label: 'View Income Statement',
        description: 'See your profit and loss for the period',
        href: '/accounting/reports/income-statement',
      },
      {
        id: 'balance-sheet',
        label: 'View Balance Sheet',
        description: 'See your assets, liabilities and equity',
        href: '/accounting/reports/balance-sheet',
      },
    ],
  },
  {
    id: 'invite-team',
    label: 'Invite Team',
    description: 'Bring your team on board',
    icon: UserPlus,
    tasks: [
      {
        id: 'invite-user',
        label: 'Add a user',
        description: 'Invite a team member or accountant',
        href: '/accounting/settings/team',
      },
      {
        id: 'set-permissions',
        label: 'Set permissions',
        description: 'Configure what each user can access',
        href: '/accounting/settings/team',
      },
    ],
  },
];

export const ALL_TASK_IDS: string[] = SETUP_CATEGORIES.flatMap(c => c.tasks.map(t => t.id));
export const TOTAL_TASK_COUNT: number = ALL_TASK_IDS.length;
