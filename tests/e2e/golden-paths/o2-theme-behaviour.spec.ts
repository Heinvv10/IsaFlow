/**
 * Golden path O2 - how the theme behaves (master plan 3b.1 / 3b.3), in a real browser.
 *
 *  - System follows the OS live; the header control switches theme; a saved Light survives a reload.
 *  - Public / customer-facing paths are light whatever is saved.
 *  - Phone width: the theme control and Log out are reachable (they live in the account menu).
 *  - Panels that are dark in both themes keep their text colour in the light theme; a
 *    data-surface="light" panel keeps light tokens and form controls in the dark theme.
 *  - Reports pin the header row and the first column to the page scroll (no nested scroll box).
 * Read-only: writes no data.
 */
import { expect, test } from '@playwright/test';
import { auditContrast } from '../helpers/themeContrast';
import { axeContrastFailures, rootTheme, seedTheme, settle } from '../helpers/themeSpec';

test.setTimeout(180_000);

test.describe('preference', () => {
  test('System follows prefers-color-scheme without a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await seedTheme(page, 'system');
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await rootTheme(page)).toEqual({ dark: true, scheme: 'dark' });

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => rootTheme(page)).toEqual({ dark: false, scheme: 'light' });
  });

  test('the header control switches theme and a saved Light survives a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect.poll(() => rootTheme(page)).toEqual({ dark: false, scheme: 'light' });
    expect(await page.evaluate(() => window.localStorage.getItem('accounting-theme'))).toBe('light');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await rootTheme(page)).toEqual({ dark: false, scheme: 'light' });
    await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the client portal is light with Dark saved, and passes axe color-contrast', async ({ page }) => {
    await seedTheme(page, 'dark');
    await page.goto('/portal', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-theme-applied]'); // the provider has run: nothing can flip it later
    expect(await rootTheme(page)).toEqual({ dark: false, scheme: 'light' });
    expect(await page.evaluate(() => window.localStorage.getItem('accounting-theme'))).toBe('dark');
    expect(await axeContrastFailures(page)).toEqual([]);
  });
});

test('phone width: the theme control, the user and Log out are reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedTheme(page, 'dark');
  await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const header = page.locator('header').first();
  const overflow = await header.evaluate((h) => h.scrollWidth - h.clientWidth);
  expect(overflow, 'the header must not scroll sideways').toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Account and display settings' }).click();
  const menu = page.getByRole('group', { name: 'Account and display settings' });
  await menu.getByRole('button', { name: 'Light', exact: true }).click();
  await expect.poll(() => rootTheme(page)).toEqual({ dark: false, scheme: 'light' });

  const logout = menu.getByRole('button', { name: 'Log out' });
  await expect(logout).toBeVisible();
  const box = await logout.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
});

test.describe('panels and surfaces', () => {
  test('a dark panel keeps its text colour in the light theme; an ordinary one is remapped', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, 'light');
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const colours = await page.evaluate(() => {
      const panels: Record<string, string> = {
        plain: '',
        slate700: 'bg-slate-700',
        slate800: 'bg-slate-800',
        teal900: 'bg-teal-900',
        hex: 'bg-[#1a1f2e]',
      };
      const host = document.createElement('div');
      host.innerHTML = Object.entries(panels)
        .map(([id, cls]) => `<div class="${cls}"><span id="t-${id}" class="text-teal-400">x</span></div>`)
        .join('') + '<div data-surface="dark"><span id="t-attr" class="text-teal-400">x</span></div>';
      document.body.appendChild(host);
      const out: Record<string, string> = {};
      for (const id of [...Object.keys(panels), 'attr']) out[id] = getComputedStyle(document.getElementById(`t-${id}`)!).color;
      return out;
    });
    expect(colours.plain, 'text-teal-400 on the page is the 800 weight').toBe('rgb(17, 94, 89)');
    for (const dark of ['slate700', 'slate800', 'teal900', 'hex', 'attr']) {
      expect(colours[dark], `${dark} panel keeps teal-400`).toBe('rgb(45, 212, 191)');
    }
  });

  test('in the dark theme, raw greys inside a data-surface="light" panel are remapped to AA on white; outside they are left alone', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, 'dark');
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const c = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML =
        '<div data-surface="light" style="background:#fff"><span id="in" class="text-slate-400">x</span><span id="inb" class="text-teal-400">x</span></div><div><span id="out" class="text-slate-400">x</span></div>';
      document.body.appendChild(host);
      const col = (id: string) => getComputedStyle(document.getElementById(id)!).color;
      return { inside: col('in'), insideTeal: col('inb'), outside: col('out') };
    });
    expect(c.inside, 'slate-400 on the white panel').toBe('rgb(91, 101, 115)');
    expect(c.insideTeal, 'teal-400 on the white panel').toBe('rgb(17, 94, 89)');
    expect(c.outside, 'slate-400 on the dark page is untouched').toBe('rgb(148, 163, 184)');
  });

  test('chart legend labels are forced to the text token in both themes (the series colour is 3.98:1 on the dark card)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const colours: Record<string, string> = {};
    for (const theme of ['light', 'dark'] as const) {
      await seedTheme(page, theme);
      await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
      colours[theme] = await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML = '<span id="lg" class="recharts-legend-item-text" style="color:rgb(244, 63, 94)">x</span>';
        document.body.appendChild(host);
        const out = getComputedStyle(document.getElementById('lg')!).color;
        host.remove();
        return out;
      });
    }
    expect(colours.light, 'light: the token wins over the series colour').toBe('rgb(75, 85, 99)');
    expect(colours.dark, 'dark: the token wins over the series colour').toBe('rgb(203, 213, 225)');
  });

  test('data-surface="light" keeps light tokens, color-scheme and form controls in the dark theme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, 'dark');
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const probe = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML =
        '<div data-surface="light" id="lp"><input id="li" /><p id="lt" style="color:var(--ff-text-primary)">x</p></div><div><input id="di" /></div>';
      document.body.appendChild(host);
      const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
      return { scheme: cs('lp').colorScheme, lightInput: cs('li').backgroundColor, text: cs('lt').color, darkInput: cs('di').backgroundColor };
    });
    expect(probe.scheme).toBe('light');
    expect(probe.text, 'light text token inside the panel').toBe('rgb(17, 24, 39)');
    expect(probe.lightInput, 'an input inside a light panel is not dark-filled').not.toBe('rgb(30, 41, 59)');
    expect(probe.darkInput, 'an ordinary input is still dark in the dark theme').toBe('rgb(30, 41, 59)');
  });
});

test.describe('reports pin the header row and the first column to the page scroll', () => {
  test.use({ viewport: { width: 760, height: 520 } });

  // The geometry is forced (a wide, tall table) so the test proves the pinning whatever data this company has:
  // comparator columns are disabled where there is no prior period, and a small company has few rows.
  const REPORTS = [
    { slug: 'income-statement', path: '/accounting/reports/income-statement' },
    { slug: 'balance-sheet', path: '/accounting/reports/balance-sheet' },
    { slug: 'trial-balance', path: '/accounting/trial-balance' },
  ] as const;

  for (const report of REPORTS) {
    test(`${report.slug}: header stays at the top and the first column at the left`, async ({ page }) => {
      await seedTheme(page, 'light');
      await page.goto(report.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.addStyleTag({ content: 'main table { min-width: 1500px !important } main table tbody tr { height: 56px !important }' });

      const main = page.locator('main');
      const table = main.locator('table').first();
      await expect(table).toBeVisible();
      const scroll = await main.evaluate((m) => ({ y: m.scrollHeight - m.clientHeight, x: m.scrollWidth - m.clientWidth, overflowY: getComputedStyle(m).overflowY }));
      expect(scroll.overflowY).toBe('auto');
      expect(scroll.y, 'the page must be tall enough to scroll or this proves nothing').toBeGreaterThan(40);
      expect(scroll.x, 'the page must be wide enough to scroll sideways or this proves nothing').toBeGreaterThan(20);
      // One scroll container: nothing between the table and <main> may scroll or clip it.
      const trapped = await table.evaluate((t) => {
        for (let el = t.parentElement; el && el.tagName !== 'MAIN'; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if ([cs.overflowX, cs.overflowY].some((o) => o === 'auto' || o === 'scroll' || o === 'hidden')) return el.className;
        }
        return null;
      });
      expect(trapped, 'an ancestor of the table is a nested scroll box').toBeNull();

      // Scroll 120px past the point where the table's own header would leave the top of the page.
      await main.evaluate((m) => {
        const t = m.querySelector('table')!;
        m.scrollTop = t.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop + 120;
        m.scrollLeft = 80;
      });
      const mainBox = await main.boundingBox();
      const headBox = await table.locator('thead th').first().boundingBox();
      const lastHeadBox = await table.locator('thead th').last().boundingBox();
      // The third body row, not the first: the first rows are band headers whose cell is not a data row. A report
      // with fewer than three rows cannot show a first column pinned under scroll, so say so instead of failing on a null box.
      const bodyRows = table.locator('tbody tr td:first-child');
      await expect.poll(() => bodyRows.count(), { message: 'the report needs at least 3 body rows for this check' }).toBeGreaterThanOrEqual(3);
      const cellBox = await bodyRows.nth(2).boundingBox();
      expect(mainBox && headBox && cellBox).toBeTruthy();
      expect(Math.abs(headBox!.y - mainBox!.y), 'header row pinned to the top of the page scroll').toBeLessThan(3);
      expect(Math.abs(lastHeadBox!.y - mainBox!.y), 'every header cell is pinned, not just the first').toBeLessThan(3);
      if (report.slug === 'trial-balance') {
        // The pinned Account column sits flush against the pinned Code column, even for a code too long for it.
        await table.locator('tbody tr td:first-child span.truncate').first().evaluate((el) => { el.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; });
        const ths = table.locator('thead th');
        const [code, account] = [await ths.nth(0).boundingBox(), await ths.nth(1).boundingBox()];
        expect(Math.abs(account!.x - (code!.x + code!.width)), 'Account header flush with Code header').toBeLessThan(2);
        const cells = table.locator('tbody tr').first().locator('td');
        const [c1, c2] = [await cells.nth(0).boundingBox(), await cells.nth(1).boundingBox()];
        expect(Math.abs(c2!.x - (c1!.x + c1!.width)), 'Account cell flush with Code cell').toBeLessThan(2);
        expect(Math.abs(c1!.width - code!.width), 'Code cell is as wide as its header').toBeLessThan(2);
      }
      expect(Math.abs(headBox!.x - mainBox!.x), 'first header cell pinned to the left').toBeLessThan(3);
      expect(Math.abs(cellBox!.x - mainBox!.x), 'first column pinned to the left').toBeLessThan(3);
    });
  }
});

test('the reports sub-navigation border spans the whole row at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await seedTheme(page, 'dark');
  await page.goto('/accounting/reports/income-statement', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.waitForSelector('div.relative.z-40 nav');
  const widths = await page.evaluate(() => {
    const navs = Array.from(document.querySelectorAll('div.relative.z-40 nav'));
    const nav = navs[navs.length - 1] as HTMLElement;
    return { nav: nav.getBoundingClientRect().width, row: (nav.closest('div.border-b') as HTMLElement).getBoundingClientRect().width };
  });
  expect(widths.nav, 'the nav (which carries the border) is as wide as its row, less the label').toBeGreaterThan(widths.row - 200);
});

test('the contrast walker exempts the label of a disabled control and nothing else', async ({ page }) => {
  await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'background:#fff;position:fixed;top:0;left:0;z-index:99999';
    const low = 'style="color:#aaa"';
    host.innerHTML = [
      // exempt: the label of a disabled control, wrapping it or pointing at it with for=
      `<label><input type="checkbox" disabled><span ${low}>wrapped-disabled</span></label>`,
      `<input type="checkbox" id="d1" disabled><label for="d1" ${low}>for-disabled</label>`,
      // not exempt
      `<label><input type="checkbox"><span ${low}>wrapped-enabled</span></label>`,
      `<input type="checkbox" id="e1"><label for="e1" ${low}>for-enabled</label>`,
      // for= names an id that does not exist, so this label has NO control, even with a disabled input inside it
      `<label for="missing-id"><input type="checkbox" disabled><span ${low}>for-missing</span></label>`,
      // a disabled input and an unrelated link in one label: the link is still a live, readable-or-not target
      `<label><input type="checkbox" disabled><a href="#x" ${low}>link-in-label</a></label>`,
    ].join('');
    document.body.appendChild(host);
  });
  const texts = (await auditContrast(page)).failing.map((f) => f.text);
  for (const exempt of ['wrapped-disabled', 'for-disabled']) expect(texts, exempt).not.toContain(exempt);
  for (const flagged of ['wrapped-enabled', 'for-enabled', 'for-missing', 'link-in-label']) expect(texts, flagged).toContain(flagged);
});
