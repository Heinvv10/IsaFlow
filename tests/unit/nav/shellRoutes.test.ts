import { describe, it, expect } from 'vitest';
import { documentTitle, isPayrollPath } from '@/components/layout/shellRoutes';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { TABS } from '@/components/accounting/accountingNavConfig';

describe('documentTitle', () => {
  const idx = buildNavIndex(TABS, true);

  it('names the page, then its module, then the product', () => {
    expect(documentTitle('/accounting/customer-invoices', idx)).toBe('Tax Invoices · Sales · IsaFlow');
  });

  it('names the module of a sub-page from its owning nav entry', () => {
    expect(documentTitle('/accounting/customer-invoices/123?x=1#top', idx)).toBe('Tax Invoices · Sales · IsaFlow');
  });

  it('gives a top-level tab its own name only', () => {
    expect(documentTitle('/accounting', idx)).toBe('Dashboard · IsaFlow');
  });

  it('names the module, not "Library", for a library-only page', () => {
    const entry = idx.find((e) => e.trail[0] === 'Library' && e.trail.length > 1)!;
    expect(documentTitle(entry.href, idx)).toBe(`${entry.label} · ${entry.trail[1]} · IsaFlow`);
  });

  it('falls back to the product name for a page the nav does not reach', () => {
    expect(documentTitle('/somewhere/else', idx)).toBe('IsaFlow');
    expect(documentTitle('/accounting/customer-invoices', [])).toBe('IsaFlow');
  });
});

describe('isPayrollPath', () => {
  it('matches /payroll and everything under it', () => {
    expect(isPayrollPath('/payroll')).toBe(true);
    expect(isPayrollPath('/payroll/runs')).toBe(true);
    expect(isPayrollPath('/payroll/runs/[id]')).toBe(true);
  });

  it('does not match a path that only starts with the same letters', () => {
    expect(isPayrollPath('/payrollx')).toBe(false);
    expect(isPayrollPath('/payroll-settings')).toBe(false);
    expect(isPayrollPath('/accounting/payroll')).toBe(false);
  });
});
