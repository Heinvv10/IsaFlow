// golden:dev-only
/**
 * Golden path (z15): table density works, and the P&L sits on the 4 px grid (master plan wave 4, DG).
 *
 * READ-ONLY, Demo company, dev only. The header toggle (`isaflow.tableDensity`) flips html[data-density]; in compact
 * the first body row of an ordinary list table is <= 34 px (py-1 cells), in comfortable it is the authored 49 px
 * for invoices, and it returns to 49 px when restored. Bank transaction and employee rows shrink. A management-pack
 * viewer row (exempt) is the same height in both modes (skipped only when Demo has no management pack). The income
 * statement's 4 px-grid share (the lfprobe `grid4` measure: padding/margin/gap values that are multiples of 4) is
 * >= 80 % in both themes, and its Export Excel button is the secondary button, not a second green.
 * Nothing is written.
 */
import { test, expect, type Page } from '@playwright/test';

const KEY = 'isaflow.tableDensity';

async function open(page: Page, path: string, density: 'comfortable' | 'compact', theme = 'light'): Promise<void> {
  await page.addInitScript(([k, d, t]) => {
    try { localStorage.setItem(k, d); localStorage.setItem('accounting-theme', t); } catch { /* storage blocked */ }
  }, [KEY, density, theme]);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

const firstRowHeight = async (page: Page): Promise<number> => {
  const row = page.locator('tbody tr').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return (await row.boundingBox())!.height;
};

test.describe('Table density and P&L grid', () => {
  test('invoice rows: 49 px comfortable, <= 34 px compact, 49 px again when restored', async ({ page }) => {
    await open(page, '/accounting/customer-invoices', 'comfortable');
    expect(await firstRowHeight(page)).toBeGreaterThanOrEqual(48);
    await page.getByRole('button', { name: /^Compact/ }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    expect(await firstRowHeight(page)).toBeLessThanOrEqual(34);
    await page.getByRole('button', { name: /^Comfortable/ }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
    expect(await firstRowHeight(page)).toBeGreaterThanOrEqual(48);
  });

  for (const [name, path] of [['bank transaction', '/accounting/bank-transactions'], ['employee', '/payroll/employees']] as const) {
    test(`${name} rows shrink in compact`, async ({ page }) => {
      await open(page, path, 'comfortable');
      const comfortable = await firstRowHeight(page);
      await page.getByRole('button', { name: /^Compact/ }).first().click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect.poll(() => firstRowHeight(page)).toBeLessThan(comfortable);
    });
  }

  test('an exempt pack/AFS viewer row is the same height in both modes', async ({ page }) => {
    await open(page, '/accounting/afs', 'comfortable');
    const link = page.locator('a[href^="/accounting/afs/"]').first();
    if (!(await link.isVisible({ timeout: 15_000 }).catch(() => false))) test.skip(true, 'Demo has no pack or AFS document');
    const href = (await link.getAttribute('href'))!;
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    const table = page.locator('table[data-density-exempt] tbody tr').first();
    await expect(table).toBeVisible({ timeout: 30_000 });
    const comfortable = (await table.boundingBox())!.height;
    await open(page, href, 'compact');
    const t2 = page.locator('table[data-density-exempt] tbody tr').first();
    await expect(t2).toBeVisible({ timeout: 30_000 });
    expect((await t2.boundingBox())!.height).toBe(comfortable);
  });

  for (const theme of ['light', 'dark']) {
    test(`income statement 4 px-grid share >= 80 % (${theme}) and Export Excel is secondary`, async ({ page }) => {
      await open(page, '/accounting/reports/income-statement', 'comfortable', theme);
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
      const share = await page.evaluate(() => {
        const vis = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.top < innerHeight * 3; };
        const all = [...document.querySelectorAll('body *')].filter(vis).slice(0, 2000);
        let grid = 0; let tot = 0;
        for (const e of all) {
          const s = getComputedStyle(e);
          for (const k of ['paddingTop', 'paddingLeft', 'marginTop', 'marginBottom', 'gap'] as const) {
            const v = parseFloat(s[k]);
            if (v > 0) { tot++; if (Math.abs(v % 4) < 0.01) grid++; }
          }
        }
        return tot ? (100 * grid) / tot : 0;
      });
      expect(share).toBeGreaterThanOrEqual(80);
      const excel = page.getByRole('button', { name: /Export Excel/ });
      await expect(excel).toBeVisible();
      expect(await excel.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
      expect(await excel.evaluate((el) => el.className)).not.toMatch(/success-|green-/);
    });
  }
});
