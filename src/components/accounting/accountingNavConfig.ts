/**
 * AccountingNav configuration — tab definitions and route resolution.
 * Standalone version: all routes are internal /accounting/* paths.
 * /clients routes replaced with /accounting/customers.
 * /suppliers routes replaced with /accounting/suppliers.
 * External links to /procurement/purchase-orders, /stock-items, /inventory removed.
 *
 * Split into navSections/ for maintainability. This file re-exports everything
 * for backward compatibility.
 */

// Import types (also re-exported below for backward compatibility)
import type { DropdownItem, FlyoutSection, NavItem, Tab } from './navSections/types';
import { isFlyout } from './navSections/types';

export type { DropdownItem, FlyoutSection, NavItem, Tab };
export { isFlyout };

// Re-export route helpers
export { getActiveTabId, isLinkActive } from './navSections/activeTab';

// Import section tabs
import { customersTab } from './navSections/customers';
import { suppliersTab } from './navSections/suppliers';
import { itemsTab } from './navSections/items';
import { bankingTab } from './navSections/banking';
import { accountsTab, vatTab } from './navSections/generalLedger';
import { accountantsTab } from './navSections/accountants';
import { reportsTab, sarsTab } from './navSections/reports';
import { toolsTab, groupTab } from './navSections/tools';
import { payrollTab } from './navSections/payroll';

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  customersTab,
  suppliersTab,
  itemsTab,
  bankingTab,
  accountsTab,
  vatTab,
  accountantsTab,
  reportsTab,
  sarsTab,
  toolsTab,
  groupTab,
  { id: 'import', label: 'Data Import', href: '/accounting/migration' },
  payrollTab,
];
