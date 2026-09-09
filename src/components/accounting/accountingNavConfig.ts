/**
 * AccountingNav configuration — 5-tab front door.
 *
 * Top nav (left → right):
 *   Dashboard · Portfolio · Month-End · Banking · Library
 *
 * The 8 module tabs (Sales, Purchases, Inventory, Accounting, Reports, Tax,
 * Payroll, Practice) are reachable via Library: click → /accounting/library
 * landing grid; hover → flyout of the 8 modules.
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
export { getActiveTabId, getActiveModuleId, isLinkActive } from './navSections/activeTab';

// Front-door section tabs
import { bankingTab } from './navSections/banking';
import { libraryTab } from './navSections/library';
import { settingsTab } from './navSections/settings';

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  { id: 'portfolio', label: 'Portfolio', href: '/accounting/portfolio-workbench' },
  { id: 'workbench', label: 'Month-End', href: '/accounting/month-end-workbench' },
  {...bankingTab,items:[...(bankingTab.items??[]),{section:'Controls',items:[{label:'Bank approvals',href:'/accounting/bank-control-approvals'}]}]},
  libraryTab,
];

// Settings tab — rendered behind the cog in the header, not in the main tab strip.
export { settingsTab };
