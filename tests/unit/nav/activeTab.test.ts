import { describe, it, expect } from 'vitest';
import { getActiveTabId, getActiveModuleId } from '@/components/accounting/navSections/activeTab';

const q = {} as Record<string, string | string[] | undefined>;

describe('getActiveModuleId (unchanged route mapping)', () => {
  it('resolves module routes to their module id', () => {
    expect(getActiveModuleId('/accounting/customers', q)).toBe('sales');
    expect(getActiveModuleId('/accounting/suppliers', q)).toBe('purchases');
    expect(getActiveModuleId('/accounting/items', q)).toBe('inventory');
    expect(getActiveModuleId('/accounting/chart-of-accounts', q)).toBe('accounting');
    expect(getActiveModuleId('/accounting/afs', q)).toBe('reports');
    expect(getActiveModuleId('/accounting/vat-201', q)).toBe('tax');
    expect(getActiveModuleId('/payroll', q)).toBe('payroll');
  });
  it('keeps the sales precedence over reports for shared report routes', () => {
    expect(getActiveModuleId('/accounting/reports/sales-by-customer', q)).toBe('sales');
  });
});

describe('getActiveTabId (top-bar wrapper)', () => {
  it('collapses demoted modules to "library"', () => {
    expect(getActiveTabId('/accounting/customers', q)).toBe('library');
    expect(getActiveTabId('/accounting/chart-of-accounts', q)).toBe('library');
    expect(getActiveTabId('/payroll', q)).toBe('library');
    expect(getActiveTabId('/accounting/library', q)).toBe('library');
  });
  it('passes through promoted + non-module ids unchanged', () => {
    expect(getActiveTabId('/accounting', q)).toBe('dashboard');
    expect(getActiveTabId('/accounting/portfolio-workbench', q)).toBe('portfolio');
    expect(getActiveTabId('/accounting/month-end-workbench', q)).toBe('workbench');
    expect(getActiveTabId('/accounting/bank-transactions', q)).toBe('banking');
    expect(getActiveTabId('/accounting/company-settings', q)).toBe('settings');
  });
});
