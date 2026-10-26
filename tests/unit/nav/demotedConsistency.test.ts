import { describe, it, expect } from 'vitest';
import {
  PROMOTED_MODULE_IDS, LIBRARY_ONLY_IDS,
} from '@/components/accounting/navSections/activeTab';
import { LIBRARY_MODULES } from '@/components/accounting/navSections/library';
import { MODULE_BY_ID } from '@/components/accounting/navSections/secondaryNav';
import { TABS } from '@/components/accounting/accountingNavConfig';

describe('module lists stay in sync across the sources', () => {
  it('promoted + library-only ids, LIBRARY_MODULES ids and MODULE_BY_ID keys are set-equal', () => {
    const fromSets = [...PROMOTED_MODULE_IDS, ...LIBRARY_ONLY_IDS].sort();
    const fromLibrary = LIBRARY_MODULES.map((m) => m.id).sort();
    const fromSecondary = Object.keys(MODULE_BY_ID).sort();
    expect(fromLibrary).toEqual(fromSets);
    expect(fromSecondary).toEqual(fromSets);
  });

  it('the two sets do not overlap', () => {
    for (const id of PROMOTED_MODULE_IDS) expect(LIBRARY_ONLY_IDS.has(id)).toBe(false);
  });

  it('every promoted module has its own top tab with a landing href and daily links', () => {
    for (const id of PROMOTED_MODULE_IDS) {
      const tab = TABS.find((t) => t.id === id);
      expect(tab, id).toBeDefined();
      expect(tab!.href, id).toMatch(/^\//);
      expect((tab!.links ?? []).length, id).toBeGreaterThanOrEqual(3);
      expect((tab!.links ?? []).length, id).toBeLessThanOrEqual(6);
    }
  });

  it('top tabs are in the agreed order', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Dashboard', 'Sales', 'Purchases', 'Banking', 'Payroll', 'Tax', 'Reports', 'Month-End', 'Portfolio', 'Library',
    ]);
  });
});
