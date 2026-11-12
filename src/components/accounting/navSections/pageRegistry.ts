/**
 * The one source for document titles: the top-nav index, then the cog's settings pages, then the pages no menu
 * reaches (EXTRA_PAGES). A menu entry always wins over an extra with the same href.
 */
import { TABS, settingsTab } from '../accountingNavConfig';
import { buildNavIndex, type NavIndexEntry } from './navIndex';
import { MODULE_BY_ID } from './secondaryNav';

/** Pages no menu reaches. href is a path prefix (segment boundary), label is the page's own heading, trail[0] its area. */
export const EXTRA_PAGES: NavIndexEntry[] = [
  { href: '/home', label: 'Home', trail: [] },
  { href: '/onboarding', label: 'Company Setup', trail: [] },
  { href: '/admin', label: 'Admin Console', trail: [] },
  { href: '/bureau', label: 'Bureau Dashboard', trail: ['Bureau'] },
  { href: '/bureau/clients', label: 'Manage Clients', trail: ['Bureau'] },
  { href: '/bureau/settings', label: 'Bureau Settings', trail: ['Bureau'] },
  { href: '/accounting?tab=chart-of-accounts', label: 'Chart of Accounts', trail: ['Accounting'] },
  { href: '/accounting?tab=journal-entries', label: 'Journal Entries', trail: ['Accounting'] },
  { href: '/accounting?tab=fiscal-periods', label: 'Fiscal Periods', trail: ['Accounting'] },
  { href: '/accounting?tab=reports', label: 'Reports', trail: [] },
  { href: '/accounting/adjustments', label: 'Adjustments', trail: [] },
  { href: '/accounting/sales-reps', label: 'Sales Reps', trail: ['Sales'] },
  { href: '/accounting/ap/supplier-statements', label: 'Supplier Statements', trail: ['Purchases'] },
  { href: '/accounting/capture', label: 'Capture', trail: ['Purchases'] },
  { href: '/accounting/supplier-purchase-orders', label: 'Purchase Orders', trail: ['Purchases'] },
  { href: '/accounting/products', label: 'Products & Inventory', trail: ['Inventory'] },
  { href: '/accounting/currencies', label: 'Currencies', trail: ['Accounting'] },
  { href: '/accounting/exchange-rates', label: 'Exchange Rates', trail: ['Accounting'] },
  { href: '/accounting/practice/reports', label: 'Practice Reports', trail: ['Practice'] },
  { href: '/accounting/sage-migration', label: 'Sage Migration', trail: ['Settings'] },
  { href: '/accounting/settings/billing', label: 'Billing', trail: ['Settings'] },
  { href: '/accounting/settings/billing/compare', label: 'Compare Plans', trail: ['Settings'] },
  { href: '/accounting/settings/billing/flows', label: 'Flows', trail: ['Settings'] },
  { href: '/accounting/audit-snapshots', label: 'Audit Snapshots', trail: ['Reports'] },
  { href: '/accounting/cash-flow-forecast', label: 'Cash Flow Forecast', trail: ['Reports'] },
  { href: '/accounting/reports/account-detail', label: 'Account Detail', trail: ['Reports'] },
  { href: '/accounting/reports/audit-trail', label: 'Audit Trail', trail: ['Reports'] },
  { href: '/accounting/reports/cash-movement', label: 'Cash Movement', trail: ['Reports'] },
  { href: '/accounting/reports/customer-communication', label: 'Customer Communication', trail: ['Reports'] },
  { href: '/accounting/reports/executive-dashboard', label: 'Executive Dashboard', trail: ['Reports'] },
  { href: '/accounting/reports/financial-analysis', label: 'Financial Analysis', trail: ['Reports'] },
  { href: '/accounting/reports/general-ledger', label: 'General Ledger', trail: ['Reports'] },
  { href: '/accounting/reports/management-accounts', label: 'Management Accounts', trail: ['Reports'] },
  { href: '/accounting/reports/report-packs', label: 'Report Packs', trail: ['Reports'] },
  { href: '/accounting/reports/three-way-forecast', label: 'Three-Way Forecast', trail: ['Reports'] },
  { href: '/accounting/reports/trend-analysis', label: 'Trend Analysis', trail: ['Reports'] },
  { href: '/accounting/reports/waterfall', label: 'Waterfall Charts', trail: ['Reports'] },
];

/**
 * Pages several menus list, titled under the module that lights for them (getActiveModuleId), not under the first
 * tab in TABS. Opening Balances is in Sales > Statement Run too, but lights Library > Accounting.
 */
const TITLE_MODULE: Record<string, string> = { '/accounting/opening-balances': 'accounting' };

/** The nav index plus the cog pages plus EXTRA_PAGES. A menu entry always wins. */
export function buildPageIndex(isVatRegistered: boolean): NavIndexEntry[] {
  const index = buildNavIndex([...TABS, settingsTab], isVatRegistered).map((e) => {
    const tab = MODULE_BY_ID[TITLE_MODULE[e.href] ?? ''];
    const owner = tab && buildNavIndex([tab], isVatRegistered).find((o) => o.href === e.href);
    return owner ? { ...e, label: owner.label, trail: owner.trail } : e;
  });
  const seen = new Set(index.map((e) => e.href));
  return [...index, ...EXTRA_PAGES.filter((e) => !seen.has(e.href))];
}
