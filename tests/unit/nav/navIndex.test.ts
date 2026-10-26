import { describe, it, expect } from 'vitest';
import { buildNavIndex, trailForPath } from '@/components/accounting/navSections/navIndex';
import { TABS } from '@/components/accounting/accountingNavConfig';
import type { Tab } from '@/components/accounting/navSections/types';

const find = (idx: ReturnType<typeof buildNavIndex>, href: string) => idx.find((e) => e.href === href);

describe('buildNavIndex', () => {
  const idx = buildNavIndex(TABS, true);

  it('gives a section page its module and section as trail, label separate', () => {
    expect(find(idx, '/accounting/customer-invoices')).toEqual({
      href: '/accounting/customer-invoices', label: 'Tax Invoices', trail: ['Sales', 'Transactions'],
    });
  });

  it('prefers the section entry over the direct-link shortcut for the same href', () => {
    expect(idx.filter((e) => e.href === '/accounting/customer-invoices')).toHaveLength(1);
  });

  it('indexes a link that is not in any section under the tab', () => {
    const tab: Tab = { id: 't', label: 'T', links: [{ label: 'Only Link', href: '/only' }] };
    expect(buildNavIndex([tab], true)).toEqual([{ href: '/only', label: 'Only Link', trail: ['T'] }]);
  });

  it('indexes top-level tabs with an empty trail', () => {
    expect(find(idx, '/accounting')).toEqual({ href: '/accounting', label: 'Dashboard', trail: [] });
  });

  it('indexes library-only modules under Library > Module > Section', () => {
    const e = find(idx, '/accounting/chart-of-accounts');
    expect(e?.trail.slice(0, 2)).toEqual(['Library', 'Accounting']);
  });

  it('never repeats the label in its own trail (Transactions > Transactions)', () => {
    expect(idx.filter((e) => e.trail.includes(e.label))).toEqual([]);
    expect(find(idx, '/accounting/bank-transactions')?.trail).toEqual(['Banking']);
    expect(find(idx, '/payroll/employees')?.trail).toEqual(['Payroll']);
  });

  it('has no duplicate hrefs', () => {
    const hrefs = idx.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('hides VAT pages from a non-vendor', () => {
    const non = buildNavIndex(TABS, false);
    expect(find(non, '/accounting/sars/vat201')).toBeUndefined();
    expect(find(idx, '/accounting/sars/vat201')).toBeDefined();
    expect(find(non, '/accounting/sars/emp201')).toBeDefined();
  });

  it('nests deeper sections into the trail', () => {
    const tab: Tab = {
      id: 'm', label: 'M',
      items: [{ section: 'A', items: [{ section: 'B', items: [{ label: 'Deep', href: '/deep' }] }] }],
    };
    expect(buildNavIndex([tab], true)[0]).toEqual({ href: '/deep', label: 'Deep', trail: ['M', 'A', 'B'] });
  });
});

describe('trailForPath', () => {
  const idx = buildNavIndex(TABS, true);

  it('returns the entry whose href owns the path', () => {
    expect(trailForPath('/accounting/customer-invoices', idx)?.label).toBe('Tax Invoices');
  });

  it('matches sub-pages, query and fragment', () => {
    expect(trailForPath('/accounting/customer-invoices/abc-123', idx)?.label).toBe('Tax Invoices');
    expect(trailForPath('/accounting/customer-invoices?status=draft#top', idx)?.label).toBe('Tax Invoices');
  });

  it('takes the most specific match', () => {
    expect(trailForPath('/accounting/bank-reconciliation/import', idx)?.label).toBe('Import Statement');
    expect(trailForPath('/accounting/bank-reconciliation', idx)?.label).toBe('Reconcile');
  });

  it('does not match a sibling that shares a prefix', () => {
    expect(trailForPath('/accounting/customer-invoicesx', idx)).toBeNull();
  });

  it('does not let the Dashboard claim every /accounting page', () => {
    expect(trailForPath('/accounting/not-a-real-page', idx)).toBeNull();
    expect(trailForPath('/accounting', idx)?.label).toBe('Dashboard');
    expect(trailForPath('/accounting#top', idx)?.label).toBe('Dashboard');
  });

  it('the Compliance Calendar owns /accounting/sars only, not its sub-pages', () => {
    expect(trailForPath('/accounting/sars', idx)?.label).toBe('Compliance Calendar');
    expect(trailForPath('/accounting/sars/not-a-page', idx)).toBeNull();
    expect(trailForPath('/accounting/sars/submissions', idx)?.label).toBe('Submission History');
  });

  it('a dashboard sub-view selected with ?tab= is not the Dashboard', () => {
    expect(trailForPath('/accounting?tab=reports', idx)).toBeNull();
    expect(trailForPath('/accounting?tab=journal-entries', idx)).toBeNull();
  });

  it('a settings tab is not "Banking Settings"', () => {
    expect(trailForPath('/accounting/company-settings?tab=general', idx)).toBeNull();
    expect(trailForPath('/accounting/company-settings?tab=profile', idx)).toBeNull();
    expect(find(idx, '/accounting/company-settings?tab=general')?.isSetting).toBe(true);
  });

  it('a payroll setup page still owns its path', () => {
    expect(trailForPath('/payroll/components', idx)?.label).toBe('Pay Components');
  });

  it('is null for a path nothing owns', () => {
    expect(trailForPath('/nowhere', idx)).toBeNull();
  });
});
