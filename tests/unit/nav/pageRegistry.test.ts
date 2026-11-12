/**
 * pageRegistry is the one source for document titles: the nav index, the cog's pages and EXTRA_PAGES. The census
 * walks pages/ and fails on any signed-in route (AppLayout / AdminLayout) that would show the bare "IsaFlow".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPageIndex, EXTRA_PAGES } from '@/components/accounting/navSections/pageRegistry';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { TABS, settingsTab } from '@/components/accounting/accountingNavConfig';
import { documentTitle } from '@/components/layout/shellRoutes';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { MODULE_BY_ID } from '@/components/accounting/navSections/secondaryNav';

const idx = buildPageIndex(true);

describe('documentTitle over the page registry', () => {
  it.each([
    ['/accounting/user-access', 'User Access · Settings · IsaFlow'],
    ['/accounting/webhooks', 'Webhooks · Settings · IsaFlow'],
    ['/developer/personal-tokens', 'Personal Access Tokens · Settings · IsaFlow'],
    ['/accounting/settings/connected-apps', 'Connected Apps · Settings · IsaFlow'],
    ['/accounting/my-account', 'My Account · Settings · IsaFlow'],
    ['/accounting/approvals', 'Approvals · Settings · IsaFlow'],
    ['/accounting/migration/customers', 'Migration Wizard · Settings · IsaFlow'],
    ['/accounting/group', 'Group Dashboard · Settings · IsaFlow'],
    ['/accounting/consolidation', 'Group Consolidation · Settings · IsaFlow'],
    ['/home', 'Home · IsaFlow'],
    ['/bureau/clients/abc', 'Manage Clients · Bureau · IsaFlow'],
    ['/admin/companies/[id]', 'Admin Console · IsaFlow'],
    ['/accounting/reports/three-way-forecast', 'Three-Way Forecast · Reports · IsaFlow'],
    ['/accounting?tab=journal-entries', 'Journal Entries · Accounting · IsaFlow'],
    ['/accounting', 'Dashboard · IsaFlow'],
    ['/accounting/customer-invoices', 'Tax Invoices · Sales · IsaFlow'],
    ['/accounting/opening-balances', 'Opening Balances · Accounting · IsaFlow'],
  ])('%s is "%s"', (route, title) => {
    expect(documentTitle(route, idx)).toBe(title);
  });

  it('titles every menu page under the module that lights for it', () => {
    // The module that lights (its second row), as the title names it: Library modules by their own name.
    const moduleLabel = (id: string): string =>
      MODULE_BY_ID[id]?.label ?? TABS.find((t) => t.id === id)?.label ?? (id === 'settings' ? 'Settings' : id);
    // Known exceptions: company-settings ?tab= links (one Settings page, linked from Tax and Banking) and
    // /accounting/timesheets (Practice page, Settings state: listed under "Not in scope").
    const allowed = new Set([
      '/accounting/company-settings?tab=netcash', '/accounting/company-settings?tab=general',
      '/accounting/company-settings?tab=vat', '/accounting/timesheets',
    ]);
    const menus = new Set(buildNavIndex([...TABS, settingsTab], true).map((e) => e.href));
    const wrong = buildPageIndex(true)
      .filter((e) => menus.has(e.href) && e.trail.length > 0 && !allowed.has(e.href))
      .map((e) => {
        const [p = '', qs = ''] = e.href.split('?');
        const area = e.trail[0] === 'Library' ? e.trail[1] : e.trail[0];
        return { href: e.href, area, lit: moduleLabel(getActiveModuleId(p, Object.fromEntries(new URLSearchParams(qs)))) };
      })
      .filter((r) => r.area !== r.lit);
    expect(wrong).toEqual([]);
  });

  it('lets a menu entry beat an extra with the same href', () => {
    const navHref = buildNavIndex(TABS, true)[0]!;
    const withClash = [...buildNavIndex([...TABS, settingsTab], true), { ...navHref, label: 'Other' }];
    expect(documentTitle(navHref.href, withClash)).toBe(documentTitle(navHref.href, idx));
  });

  it('has no duplicate extra and no extra the nav already names (a dead row)', () => {
    const hrefs = EXTRA_PAGES.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const nav = new Set(buildNavIndex([...TABS, settingsTab], true).map((e) => e.href));
    expect(hrefs.filter((h) => nav.has(h))).toEqual([]);
  });
});

const ROOT = path.resolve(__dirname, '../../../pages');
const SHELL = /import[^;]*\b(AppLayout|AdminLayout|ReapplyTermsView)\b/;

function pageFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('_') || (dir === ROOT && d.name === 'api')) return [];
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return pageFiles(full);
    return /\.tsx?$/.test(d.name) ? [full] : [];
  });
}

function routeOf(file: string): string {
  const r = '/' + path.relative(ROOT, file).replace(/\.tsx?$/, '').replace(/(^|\/)index$/, '');
  return r === '/' ? '/' : r.replace(/\/$/, '');
}

describe('census: every signed-in page has a title', () => {
  const files = pageFiles(ROOT);

  it('walks the real pages tree', () => {
    expect(files.length).toBeGreaterThanOrEqual(300);
  });

  it('no AppLayout / AdminLayout page without its own <title> falls back to the bare product name', () => {
    const bare = files
      .filter((f) => { const s = fs.readFileSync(f, 'utf8'); return SHELL.test(s) && !s.includes('<title'); })
      .map(routeOf)
      .filter((r) => documentTitle(r, idx) === 'IsaFlow');
    expect(bare).toEqual([]);
  });
});
