/**
 * The nav filter that hides VAT surfaces from companies that are not VAT
 * vendors. Guards the two failure modes that matter: a non-vendor being shown
 * a VAT201 link, and a registered vendor losing its VAT nav.
 */
import { describe, it, expect } from 'vitest';
import { stripVatNav, isVatSurfaceHref } from '@/components/accounting/navSections/vatNav';
import { taxTab } from '@/components/accounting/navSections/tax';
import { vatTab } from '@/components/accounting/navSections/generalLedger';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

function hrefs(items: NavItem[] | undefined): string[] {
  if (!items) return [];
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}

function allHrefs(tabs: Tab[]): string[] {
  return tabs.flatMap((t) => [...(t.href ? [t.href] : []), ...hrefs(t.items), ...hrefs(t.topItems)]);
}

describe('isVatSurfaceHref', () => {
  it('matches the VAT-only pages', () => {
    expect(isVatSurfaceHref('/accounting/sars/vat201')).toBe(true);
    expect(isVatSurfaceHref('/accounting/reports/vat-return')).toBe(true);
    expect(isVatSurfaceHref('/accounting/drc-vat')).toBe(true);
  });

  it('leaves the VAT settings link alone — it is how a company registers later', () => {
    expect(isVatSurfaceHref('/accounting/company-settings?tab=vat')).toBe(false);
  });

  it('does not match unrelated SARS pages', () => {
    expect(isVatSurfaceHref('/accounting/sars')).toBe(false);
    expect(isVatSurfaceHref('/accounting/sars/emp201')).toBe(false);
  });
});

describe('stripVatNav', () => {
  it('returns the same tabs untouched for a registered vendor', () => {
    expect(stripVatNav(TABS, true)).toBe(TABS);
  });

  it('removes every VAT link from the full nav tree for a non-vendor', () => {
    const stripped = allHrefs(stripVatNav(TABS, false));
    expect(stripped.filter(isVatSurfaceHref)).toEqual([]);
  });

  it('keeps the Tax tab, minus VAT — EMP201 and the calendar still apply', () => {
    const tax = stripVatNav([taxTab], false)[0];
    expect(tax).toBeDefined();
    const links = hrefs(tax!.items);
    expect(links).toContain('/accounting/sars/emp201');
    expect(links).toContain('/accounting/sars');
    expect(links).not.toContain('/accounting/sars/vat201');
  });

  it('keeps the VAT settings link so a newly-registered company can switch on', () => {
    const tax = stripVatNav([taxTab], false)[0]!;
    expect(hrefs(tax.items)).toContain('/accounting/company-settings?tab=vat');
  });

  it('drops the dedicated VAT tab entirely', () => {
    expect(stripVatNav([vatTab], false)).toEqual([]);
    expect(stripVatNav([vatTab], true)).toHaveLength(1);
  });

  it('drops a section left empty rather than rendering an empty heading', () => {
    const tab: Tab = {
      id: 'x', label: 'X',
      items: [{ section: 'VAT', items: [{ label: 'VAT201', href: '/accounting/sars/vat201' }] }],
    };
    expect(stripVatNav([tab], false)).toEqual([]);
  });
});
