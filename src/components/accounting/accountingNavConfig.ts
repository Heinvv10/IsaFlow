/**
 * AccountingNav configuration — Option B: Sage/Xero-style 9-menu spine.
 *
 * Top nav (left → right):
 *   Dashboard · Sales · Purchases · Inventory · Banking · Accounting · Reports · Tax · Payroll
 *
 * Settings lives behind a cog icon in the AppLayout header (top-right), not in the
 * main tab bar. The settingsTab below is exported for the cog flyout to consume.
 */

// Import types (also re-exported below for backward compatibility)
import type { DropdownItem, FlyoutSection, NavItem, Tab } from './navSections/types';
import { isFlyout } from './navSections/types';

export type { DropdownItem, FlyoutSection, NavItem, Tab };
export { isFlyout };

// Re-export route helpers
export { getActiveTabId, isLinkActive } from './navSections/activeTab';

// Option B section tabs
import { salesTab } from './navSections/sales';
import { purchasesTab } from './navSections/purchases';
import { inventoryTab } from './navSections/inventory';
import { bankingTab } from './navSections/banking';
import { accountingTab } from './navSections/accounting';
import { reportsTab } from './navSections/reports';
import { taxTab } from './navSections/tax';
import { payrollTab } from './navSections/payroll';
import { settingsTab } from './navSections/settings';

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  salesTab,
  purchasesTab,
  inventoryTab,
  bankingTab,
  accountingTab,
  reportsTab,
  taxTab,
  payrollTab,
];

// Settings tab — rendered behind the cog in the header, not in the main tab strip.
export { settingsTab };
