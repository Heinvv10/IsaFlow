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
    await page.waitForSelector('input, button');
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

  const REPORTS = [
    { slug: 'income-statement', path: '/accounting/reports/income-statement', widen: ['Budget', '12-month trend'], sideways: true },
    { slug: 'balance-sheet', path: '/accounting/reports/balance-sheet', widen: ['Variance', '12-month trend'], sideways: false },
    { slug: 'trial-balance', path: '/accounting/trial-balance', widen: ['Show movement'], sideways: true },
  ] as const;

  for (const report of REPORTS) {
    test(`${report.slug}: header stays at the top and the first column at the left`, async ({ page }) => {
      await seedTheme(page, 'light');
      await page.goto(report.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      for (const label of report.widen) {
        await page.getByLabel(label).or(page.getByRole('button', { name: label })).first().click();
      }
      await settle(page);

      const main = page.locator('main');
      const table = main.locator('table').first();
      await expect(table).toBeVisible();
      const scroll = await main.evaluate((m) => ({ y: m.scrollHeight - m.clientHeight, x: m.scrollWidth - m.clientWidth, overflowY: getComputedStyle(m).overflowY }));
      expect(scroll.overflowY).toBe('auto');
      expect(scroll.y, 'the page must be tall enough to scroll or this proves nothing').toBeGreaterThan(40);
      if (report.sideways) expect(scroll.x, 'the page must be wide enough to scroll sideways or this proves nothing').toBeGreaterThan(20);
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
      const cellBox = await table.locator('tbody tr td:first-child').nth(2).boundingBox();
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
      if (report.sideways) {
        expect(Math.abs(headBox!.x - mainBox!.x), 'first header cell pinned to the left').toBeLessThan(3);
        expect(Math.abs(cellBox!.x - mainBox!.x), 'first column pinned to the left').toBeLessThan(3);
      }
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
