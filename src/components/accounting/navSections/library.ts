/**
 * Library config — single source of truth for the demoted-module surface.
 *
 * Used by both the Library top-tab flyout (`libraryTab`) and the
 * /accounting/library landing grid (`LIBRARY_MODULES`). The 8 modules
 * here are everything NOT promoted to the front door (Dashboard,
 * Portfolio, Month-End, Banking stay top-level).
 */
import React from 'react';
import {
  ShoppingCart, Truck, Package, BookOpen,
  BarChart3, Receipt, Users, Briefcase,
} from 'lucide-react';
import type { Tab, FlyoutSection } from './types';

import { salesTab } from './sales';
import { purchasesTab } from './purchases';
import { inventoryTab } from './inventory';
import { accountingTab } from './accounting';
import { reportsTab } from './reports';
import { taxTab } from './tax';
import { payrollTab } from './payroll';
import { practiceTab } from './practice';

const MODULE_TABS: Tab[] = [
  salesTab, purchasesTab, inventoryTab, accountingTab,
  reportsTab, taxTab, payrollTab, practiceTab,
];

/** Each demoted module becomes one flyout section holding its own nav tree. */
const moduleSection = (t: Tab): FlyoutSection => ({
  section: t.label,
  items: t.items ?? [],
});

export const libraryTab: Tab = {
  id: 'library',
  label: 'Library',
  href: '/accounting/library',
  items: MODULE_TABS.map(moduleSection),
};

export interface LibraryModule {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: React.ReactNode;
}

const ICON = 'h-5 w-5';

export const LIBRARY_MODULES: LibraryModule[] = [
  { id: 'sales',      label: 'Sales',      description: 'Customers, invoices, quotes & receivables',     href: '/accounting/customers',                 icon: React.createElement(ShoppingCart, { className: ICON }) },
  { id: 'purchases',  label: 'Purchases',  description: 'Suppliers, bills, orders & payments',           href: '/accounting/suppliers',                 icon: React.createElement(Truck, { className: ICON }) },
  { id: 'inventory',  label: 'Inventory',  description: 'Items, stock levels & valuation',               href: '/accounting/items',                     icon: React.createElement(Package, { className: ICON }) },
  { id: 'accounting', label: 'Accounting', description: 'Chart of accounts, journals & periods',         href: '/accounting/chart-of-accounts',         icon: React.createElement(BookOpen, { className: ICON }) },
  { id: 'reports',    label: 'Reports',    description: 'Financial statements, AFS & management packs',  href: '/accounting/reports/income-statement',  icon: React.createElement(BarChart3, { className: ICON }) },
  { id: 'tax',        label: 'Tax',        description: 'VAT returns, SARS & tax submissions',           href: '/accounting/reports/vat-return',        icon: React.createElement(Receipt, { className: ICON }) },
  { id: 'payroll',    label: 'Payroll',    description: 'Employees, pay runs & leave',                   href: '/payroll',                              icon: React.createElement(Users, { className: ICON }) },
  { id: 'practice',   label: 'Practice',   description: 'Clients, jobs, time & WIP for your firm',       href: '/accounting/practice/clients',          icon: React.createElement(Briefcase, { className: ICON }) },
];

/**
 * The library grid for a company that is not a VAT vendor: the Tax tile still
 * exists (EMP201, EMP501, provisional tax, CIPC all live there) but points at
 * the compliance calendar instead of a VAT return the company never files.
 */
export function libraryModulesFor(isVatRegistered: boolean): LibraryModule[] {
  if (isVatRegistered) return LIBRARY_MODULES;
  return LIBRARY_MODULES.map((m) =>
    m.id === 'tax'
      ? { ...m, description: 'SARS submissions & compliance calendar', href: '/accounting/sars' }
      : m,
  );
}
