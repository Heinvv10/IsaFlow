/**
 * Census: every page a module's menu lists must light that module (getActiveModuleId), or the user opens a Sales
 * page and sees Dashboard lit. Fails when a menu gains a link the hand-written resolver does not know.
 */
import { describe, it, expect } from 'vitest';
import { TABS, settingsTab } from '@/components/accounting/accountingNavConfig';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { MODULE_BY_ID } from '@/components/accounting/navSections/secondaryNav';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

const bankingTab = TABS.find((t) => t.id === 'banking');
const MODULES: Record<string, Tab> = { ...MODULE_BY_ID, banking: bankingTab!, settings: settingsTab };

/**
 * Links that resolve elsewhere on purpose. `company-settings?tab=` is one Settings page; Tax and Banking link
 * straight to their own tab of it, and the page itself is the cog's.
 */
const ALLOWED = new Set([
  '/accounting/company-settings?tab=vat',
  '/accounting/company-settings?tab=netcash',
  '/accounting/company-settings?tab=general',
]);

function hrefs(items: NavItem[]): string[] {
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}

function listedBy(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, tab] of Object.entries(MODULES)) {
    const all = [...hrefs(tab.items ?? []), ...(tab.links ?? []).map((l) => l.href), ...(tab.topItems ?? []).map((l) => l.href)];
    for (const href of all) {
      const ids = out.get(href) ?? [];
      if (!ids.includes(id)) ids.push(id);
      out.set(href, ids);
    }
  }
  return out;
}

function resolve(href: string): string {
  const [path = '', qs = ''] = (href.split('#')[0] ?? '').split('?');
  return getActiveModuleId(path, Object.fromEntries(new URLSearchParams(qs)));
}

describe('nav ownership census', () => {
  const listed = listedBy();

  it('walks a real menu set', () => {
    expect(bankingTab).toBeDefined();
    expect(listed.size).toBeGreaterThan(150);
  });

  it('every listed page lights a module that lists it', () => {
    const wrong = [...listed]
      .filter(([href]) => !ALLOWED.has(href))
      .map(([href, ids]) => ({ href, ids, got: resolve(href) }))
      .filter((r) => !r.ids.includes(r.got));
    expect(wrong).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    for (const href of ALLOWED) {
      expect(listed.has(href), href).toBe(true);
      expect(listed.get(href)!.includes(resolve(href)), href).toBe(false);
    }
  });
});
