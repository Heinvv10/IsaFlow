import { describe, it, expect } from 'vitest';
import { getActiveTabId, getActiveModuleId, mostSpecificActiveHref } from '@/components/accounting/navSections/activeTab';

const q = {} as Record<string, string | string[] | undefined>;

describe('getActiveModuleId (unchanged route mapping)', () => {
  it('resolves module routes to their module id', () => {
    expect(getActiveModuleId('/accounting/customers', q)).toBe('sales');
    expect(getActiveModuleId('/accounting/suppliers', q)).toBe('purchases');
    expect(getActiveModuleId('/accounting/items', q)).toBe('inventory');
    expect(getActiveModuleId('/accounting/chart-of-accounts', q)).toBe('accounting');
    expect(getActiveModuleId('/accounting/afs', q)).toBe('reports');
    expect(getActiveModuleId('/accounting/vat-201', q)).toBe('tax');
    expect(getActiveModuleId('/accounting/practice/clients', q)).toBe('practice');
    expect(getActiveModuleId('/payroll', q)).toBe('payroll');
  });
  it('keeps the sales precedence over reports for shared report routes', () => {
    expect(getActiveModuleId('/accounting/reports/sales-by-customer', q)).toBe('sales');
  });
});

describe('getActiveTabId (top-bar wrapper)', () => {
  it('returns the module id for the promoted modules', () => {
    expect(getActiveTabId('/accounting/customers', q)).toBe('sales');
    expect(getActiveTabId('/accounting/customer-invoices/new', q)).toBe('sales');
    expect(getActiveTabId('/accounting/suppliers', q)).toBe('purchases');
    expect(getActiveTabId('/payroll', q)).toBe('payroll');
    expect(getActiveTabId('/payroll/runs/123', q)).toBe('payroll');
    expect(getActiveTabId('/accounting/sars/vat201', q)).toBe('tax');
    expect(getActiveTabId('/accounting/reports/income-statement', q)).toBe('reports');
  });
  it('collapses the library-only modules to "library"', () => {
    expect(getActiveTabId('/accounting/items', q)).toBe('library');
    expect(getActiveTabId('/accounting/chart-of-accounts', q)).toBe('library');
    expect(getActiveTabId('/accounting/practice/clients', q)).toBe('library');
    expect(getActiveTabId('/accounting/library', q)).toBe('library');
  });
  it('passes through non-module ids unchanged', () => {
    expect(getActiveTabId('/accounting', q)).toBe('dashboard');
    expect(getActiveTabId('/accounting/portfolio-workbench', q)).toBe('portfolio');
    expect(getActiveTabId('/accounting/month-end-workbench', q)).toBe('workbench');
    expect(getActiveTabId('/accounting/bank-transactions', q)).toBe('banking');
    expect(getActiveTabId('/accounting/company-settings', q)).toBe('settings');
  });
});

describe('Trial Balance belongs to Reports', () => {
  it('lights the Reports tab and module, not Library', () => {
    expect(getActiveModuleId('/accounting/trial-balance', q)).toBe('reports');
    expect(getActiveTabId('/accounting/trial-balance', q)).toBe('reports');
    expect(getActiveTabId('/accounting/trial-balance/export', q)).toBe('reports');
  });
});

describe('mostSpecificActiveHref', () => {
  it('prefers the deeper path whatever the order', () => {
    const a = '/accounting/bank-reconciliation';
    const b = '/accounting/bank-reconciliation/import';
    expect(mostSpecificActiveHref([a, b], `${b}`)).toBe(b);
    expect(mostSpecificActiveHref([b, a], `${b}`)).toBe(b);
  });

  it('does not let /a/b claim /a/bc (segment boundary)', () => {
    expect(mostSpecificActiveHref(['/a', '/a/b'], '/a/bc')).toBe('/a');
    expect(mostSpecificActiveHref(['/a/b'], '/a/bc')).toBeNull();
    expect(mostSpecificActiveHref(['/a/b', '/a'], '/a/b/c')).toBe('/a/b');
  });

  it('breaks a same-path tie by the full query length', () => {
    const hrefs = ['/s?tab=a', '/s?tab=ab'];
    expect(mostSpecificActiveHref(hrefs, '/s?tab=ab')).toBe('/s?tab=ab');
    expect(mostSpecificActiveHref([...hrefs].reverse(), '/s?tab=ab')).toBe('/s?tab=ab');
  });

  it('ranks a query link above the bare path', () => {
    expect(mostSpecificActiveHref(['/s', '/s?t=1'], '/s?t=1')).toBe('/s?t=1');
    expect(mostSpecificActiveHref(['/s?t=1', '/s'], '/s?t=1')).toBe('/s?t=1');
    // a one-char query must still beat no query
    expect(mostSpecificActiveHref(['/s', '/s?x'], '/s?x')).toBe('/s?x');
  });

  it('is null when nothing matches', () => {
    expect(mostSpecificActiveHref(['/x', '/y'], '/z')).toBeNull();
  });
});
