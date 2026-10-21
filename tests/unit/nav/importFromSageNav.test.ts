/**
 * "Import from Sage" in the nav leads to the file-upload Migration Wizard
 * (CSV / Excel exported from Sage). There is no Sage sign-in page to link to,
 * and every href it uses must be a page that exists.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsTab } from '@/components/accounting/navSections/settings';
import { toolsTab } from '@/components/accounting/navSections/tools';
import { isFlyout, type DropdownItem, type NavItem } from '@/components/accounting/navSections/types';

const flatten = (items: NavItem[]): DropdownItem[] => items.flatMap((i) => (isFlyout(i) ? flatten(i.items) : [i]));
const links = [settingsTab, toolsTab].flatMap((t) => [...(t.topItems ?? []), ...flatten(t.items ?? [])]);
const pageExists = (href: string) =>
  ['.tsx', '/index.tsx'].some((ext) => existsSync(join(process.cwd(), 'pages', `${href.split('#')[0]}${ext}`)));

describe('nav: Import from Sage', () => {
  it('is in both tabs and points at the Migration Wizard\'s Sage opener', () => {
    const sage = links.filter((l) => l.label === 'Import from Sage');
    expect(sage).toHaveLength(2);
    for (const l of sage) expect(l.href).toBe('/accounting/migration#sage');
  });

  // The nav components key items by href: a repeat is a React duplicate key
  // and two entries highlighting together.
  it('no tab repeats an href', () => {
    for (const tab of [settingsTab, toolsTab]) {
      const hrefs = [...(tab.topItems ?? []), ...flatten(tab.items ?? [])].map((l) => l.href);
      expect(hrefs.length - new Set(hrefs).size, tab.id).toBe(0);
    }
  });

  it('every migration link resolves to a page', () => {
    const migration = links.filter((l) => l.href.startsWith('/accounting/migration'));
    expect(migration.length).toBeGreaterThan(0);
    for (const l of migration) expect(pageExists(l.href), l.href).toBe(true);
  });
});
