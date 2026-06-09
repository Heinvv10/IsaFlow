import { describe, it, expect } from 'vitest';
import { DEMOTED_MODULE_IDS } from '@/components/accounting/navSections/activeTab';
import { LIBRARY_MODULES } from '@/components/accounting/navSections/library';
import { MODULE_BY_ID } from '@/components/accounting/navSections/secondaryNav';

describe('demoted module list stays in sync across the three sources', () => {
  it('DEMOTED_MODULE_IDS, LIBRARY_MODULES ids, and MODULE_BY_ID keys are set-equal', () => {
    const fromSet = [...DEMOTED_MODULE_IDS].sort();
    const fromLibrary = LIBRARY_MODULES.map((m) => m.id).sort();
    const fromSecondary = Object.keys(MODULE_BY_ID).sort();
    expect(fromLibrary).toEqual(fromSet);
    expect(fromSecondary).toEqual(fromSet);
  });
});
