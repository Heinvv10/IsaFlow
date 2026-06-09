import { describe, it, expect } from 'vitest';
import { libraryTab, LIBRARY_MODULES } from '@/components/accounting/navSections/library';
import { isFlyout } from '@/components/accounting/navSections/types';

const DEMOTED = ['sales', 'purchases', 'inventory', 'accounting', 'reports', 'tax', 'payroll', 'practice'];

describe('libraryTab', () => {
  it('is a link+flyout tab pointing at the landing page', () => {
    expect(libraryTab.id).toBe('library');
    expect(libraryTab.label).toBe('Library');
    expect(libraryTab.href).toBe('/accounting/library');
    expect(libraryTab.items && libraryTab.items.length).toBe(8);
  });

  it('folds each demoted module into its own flyout section', () => {
    const sections = (libraryTab.items ?? []).filter(isFlyout).map((s) => s.section);
    expect(sections).toEqual(['Sales', 'Purchases', 'Inventory', 'Accounting', 'Reports', 'Tax', 'Payroll', 'Practice']);
  });
});

describe('LIBRARY_MODULES', () => {
  it('has one card per demoted module with a route-shaped href and no dupes', () => {
    expect(LIBRARY_MODULES.map((m) => m.id)).toEqual(DEMOTED);
    for (const m of LIBRARY_MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.href.startsWith('/')).toBe(true);
      expect(typeof m.icon).toBe('object'); // a React element
    }
    expect(new Set(LIBRARY_MODULES.map((m) => m.href)).size).toBe(LIBRARY_MODULES.length);
  });
});
