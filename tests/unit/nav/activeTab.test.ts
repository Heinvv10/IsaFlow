import { describe, it, expect } from 'vitest';
import { getActiveTabId, getActiveModuleId, mostSpecificActiveHref } from '@/components/accounting/navSections/activeTab';
import { TABS } from '@/components/accounting/accountingNavConfig';

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

describe('Budgets belongs to Library (Accounting module, Management Accounting)', () => {
  // The nav links /accounting/budgets from navSections/accounting.ts; /accounting/budgets/workspace
  // is the old preview URL, a permanent redirect (next.config.js) that must light the same tab.
  it.each(['/accounting/budgets', '/accounting/budgets/workspace'])('%s lights Library and the Budgets link', (path) => {
    expect(getActiveModuleId(path, q)).toBe('accounting');
    expect(getActiveTabId(path, q)).toBe('library');
    expect(mostSpecificActiveHref(['/accounting/cost-centres', '/accounting/budgets', '/accounting/reports/budget-vs-actual'], path))
      .toBe('/accounting/budgets');
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

  it('an exact-only link owns its own path but not its sub-pages', () => {
    expect(mostSpecificActiveHref(['/accounting/sars'], '/accounting/sars')).toBe('/accounting/sars');
    expect(mostSpecificActiveHref(['/accounting/sars'], '/accounting/sars/vat201')).toBeNull();
    expect(mostSpecificActiveHref(['/accounting/sars'], '/accounting/sars?x=1#top')).toBe('/accounting/sars');
    expect(mostSpecificActiveHref(['/accounting'], '/accounting/customers')).toBeNull();
  });

  it('is null when nothing matches', () => {
    expect(mostSpecificActiveHref(['/x', '/y'], '/z')).toBeNull();
  });
});

describe('pages outside a module light the module that lists them (app audit P2.5 item 10)', () => {
  it.each(['/payroll/uif', '/payroll/emp501', '/payroll/irp5', '/payroll/tax-directives'])(
    '%s is a Payroll page, not a Tax one', (path) => {
      expect(getActiveModuleId(path, q)).toBe('payroll');
      expect(getActiveTabId(path, q)).toBe('payroll');
    });

  it('keeps the SARS EMP201 filing page under Tax', () => {
    expect(getActiveTabId('/accounting/sars/emp201', q)).toBe('tax');
  });

  it.each(['/accounting/audit-log', '/accounting/change-history'])('%s is a Reports page', (path) => {
    expect(getActiveModuleId(path, q)).toBe('reports');
    expect(getActiveTabId(path, q)).toBe('reports');
  });

  it('adjustments with no ?type= light Sales, as the page defaults to customer', () => {
    expect(getActiveModuleId('/accounting/adjustments', q)).toBe('sales');
    expect(getActiveModuleId('/accounting/adjustments', { type: 'customer' })).toBe('sales');
    expect(getActiveModuleId('/accounting/adjustments', { type: 'supplier' })).toBe('purchases');
  });

  it.each([
    '/accounting/user-access', '/accounting/webhooks', '/developer/personal-tokens', '/developer/oauth-apps',
    '/accounting/settings/connected-apps', '/accounting/settings/integrations-mcp', '/accounting/settings/billing/flows',
  ])('%s is a Settings page, not the Dashboard', (path) => {
    expect(getActiveModuleId(path, q)).toBe('settings');
  });

  it.each(['/bureau', '/bureau/clients', '/bureau/clients/[companyId]', '/bureau/settings'])(
    '%s is Bureau: no top tab lights, not the Dashboard', (path) => {
      expect(getActiveModuleId(path, q)).toBe('bureau');
      expect(getActiveTabId(path, q)).toBe('bureau');
      expect(TABS.some((t) => t.id === 'bureau')).toBe(false);
    });

  it('does not claim a route that only starts with "bureau"', () => {
    expect(getActiveModuleId('/bureaux', q)).toBe('dashboard');
  });

  it('keeps the accounting settings sub-pages under Accounting', () => {
    expect(getActiveModuleId('/accounting/settings/currencies', q)).toBe('accounting');
  });

  it.each([
    ['/accounting/bank/statements', 'banking'], ['/accounting/cashbook', 'banking'], ['/accounting/netcash', 'banking'],
    ['/accounting/loans/new', 'library'], ['/accounting/expenses', 'purchases'], ['/accounting/delivery-notes', 'sales'],
  ])('%s lights %s', (path, tab) => {
    expect(getActiveTabId(path, q)).toBe(tab);
  });

  it('has no top tab for Settings: the top bar lights nothing there by design, the cog does', async () => {
    const { TABS } = await import('@/components/accounting/accountingNavConfig');
    expect(TABS.some((t) => t.id === 'settings')).toBe(false);
  });
});
