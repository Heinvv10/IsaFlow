/**
 * AccountingNav configuration — 10-tab front door, every menu opens on hover.
 *
 * Top nav (left → right):
 *   Dashboard · Sales · Purchases · Banking · Payroll · Tax · Reports ·
 *   Month-End · Portfolio · Library
 *
 * Each promoted module carries `href` (its landing page) and `links` (the
 * daily set); its sections stay as flyout rows. Library still lists all 8
 * modules (Sales, Purchases, Inventory, Accounting, Reports, Tax, Payroll,
 * Practice): click → /accounting/library landing grid; hover → flyout.
 *
 * Settings lives behind a cog icon in the AppLayout header (top-right), not
 * in the main tab bar. The settingsTab below is exported for the cog flyout.
 */

// Import types (also re-exported below for backward compatibility)
import type { DropdownItem, FlyoutSection, NavItem, Tab } from './navSections/types';
import { isFlyout } from './navSections/types';

export type { DropdownItem, FlyoutSection, NavItem, Tab };
export { isFlyout };

// Re-export route helpers
export { getActiveTabId, getActiveModuleId, isLinkActive, pathMatchesHref, mostSpecificActiveHref, activeHrefAmong } from './navSections/activeTab';

// Front-door section tabs
import { bankingTab } from './navSections/banking';
import { libraryTab } from './navSections/library';
import { salesTab } from './navSections/sales';
import { purchasesTab } from './navSections/purchases';
import { payrollTab } from './navSections/payroll';
import { taxTab } from './navSections/tax';
import { reportsTab } from './navSections/reports';
import { settingsTab } from './navSections/settings';

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  salesTab,
  purchasesTab,
  bankingTab,
  payrollTab,
  taxTab,
  reportsTab,
  { id: 'workbench', label: 'Month-End', href: '/accounting/month-end-workbench' },
  { id: 'portfolio', label: 'Portfolio', href: '/accounting/portfolio-workbench' },
  libraryTab,
];

// Settings tab — rendered behind the cog in the header, not in the main tab strip.
export { settingsTab };
