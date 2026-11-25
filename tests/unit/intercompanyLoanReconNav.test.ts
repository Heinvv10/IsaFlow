/**
 * Intercompany P5: Settings > Intercompany gains "Loan reconciliation", hidden from a company without the dark flag
 * `intercompany_loan_clearing` (the page and its API check the flag themselves: hiding is cosmetic). The other intercompany pages stay.
 */
import { describe, expect, it } from 'vitest';
import { flagOfHref, FEATURE_NAV_FLAGS, MODULE_READ_NAV_FLAGS, NAV_FLAGS, stripFlagNav } from '@/components/accounting/navSections/flagNav';
import { settingsTab, TABS } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { isFlyout, type NavItem } from '@/components/accounting/navSections/types';

const HREF = '/accounting/settings/intercompany/loan-reconciliation';
const hrefs = (items: NavItem[] | undefined): string[] => (items ?? []).flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));

describe('Loan reconciliation in the nav', () => {
  it('is in Settings > Intercompany, after the pairing page', () => {
    const section = (settingsTab.items ?? []).find((s) => isFlyout(s) && s.section === 'Intercompany');
    expect(section && isFlyout(section) ? hrefs(section.items) : []).toEqual([
      '/accounting/settings/intercompany', '/accounting/settings/intercompany/pairing', HREF,
    ]);
    expect(section && isFlyout(section) ? section.items[2] : null).toMatchObject({ label: 'Loan reconciliation' });
    expect(buildNavIndex([...TABS, settingsTab], true, new Set(NAV_FLAGS)).some((e) => e.href === HREF)).toBe(true);
    expect(buildNavIndex([...TABS, settingsTab], true, new Set(MODULE_READ_NAV_FLAGS)).some((e) => e.href === HREF)).toBe(false);
  });

  it('needs the dark flag; the connections and pairing pages do not', () => {
    expect(flagOfHref(HREF)).toBe('intercompany_loan_clearing');
    expect(flagOfHref(`${HREF}?connection=x`)).toBe('intercompany_loan_clearing');
    expect(flagOfHref('/accounting/settings/intercompany')).toBeNull();
    expect(flagOfHref('/accounting/settings/intercompany/pairing')).toBeNull();
    expect(FEATURE_NAV_FLAGS).toContain('intercompany_loan_clearing');
  });

  it('is stripped for a company without the flag and kept for one with it', () => {
    expect(hrefs(stripFlagNav([settingsTab], new Set(MODULE_READ_NAV_FLAGS))[0]!.items)).not.toContain(HREF);
    expect(hrefs(stripFlagNav([settingsTab], new Set(MODULE_READ_NAV_FLAGS))[0]!.items)).toContain('/accounting/settings/intercompany/pairing');
    expect(hrefs(stripFlagNav([settingsTab], new Set(NAV_FLAGS))[0]!.items)).toContain(HREF);
  });
});
