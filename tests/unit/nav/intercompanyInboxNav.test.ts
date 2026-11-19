/** The Bills > Intercompany inbox page is in the nav (Purchases > Transactions), titled, and lights the Purchases module. */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { buildPageIndex } from '@/components/accounting/navSections/pageRegistry';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { documentTitle } from '@/components/layout/shellRoutes';

const HREF = '/accounting/supplier-invoices/intercompany';

const purchasesTab = TABS.find((t) => t.id === 'purchases')!;

describe('intercompany inbox nav entry', () => {
  it('is under Transactions of Purchases, next to Invoices', () => {
    const section = purchasesTab.items!.find((s) => 'section' in s && s.section === 'Transactions');
    expect(JSON.stringify(section)).toContain(`"label":"Invoices","href":"/accounting/supplier-invoices"},{"label":"Intercompany Inbox","href":"${HREF}"}`);
  });

  it('lights the Purchases module and has the document title of its label', () => {
    expect(getActiveModuleId(HREF, {})).toBe('purchases');
    expect(documentTitle(HREF, buildPageIndex(true))).toMatch(/^Intercompany Inbox · /);
  });
});
