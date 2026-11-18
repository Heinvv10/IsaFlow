/** The Settings > Intercompany connections page is in the nav, titled, and lights the Settings module. */
import { describe, expect, it } from 'vitest';
import { settingsTab } from '@/components/accounting/accountingNavConfig';
import { buildPageIndex } from '@/components/accounting/navSections/pageRegistry';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { documentTitle } from '@/components/layout/shellRoutes';

const HREF = '/accounting/settings/intercompany';

describe('intercompany connections nav entry', () => {
  it('is under an Intercompany section of Settings, labelled apart from Group > Intercompany Reconciliation', () => {
    const section = settingsTab.items.find((s) => 'section' in s && s.section === 'Intercompany');
    expect(section).toBeDefined();
    expect(JSON.stringify(section)).toContain(`"label":"Intercompany connections","href":"${HREF}"`);
  });

  it('lights the Settings module and has the document title of its label', () => {
    expect(getActiveModuleId(HREF, {})).toBe('settings');
    expect(documentTitle(HREF, buildPageIndex(true))).toBe('Intercompany connections · Settings · IsaFlow');
  });
});
