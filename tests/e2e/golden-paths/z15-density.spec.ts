// golden:dev-only
/**
 * Golden path (z15): table density works, and the P&L sits on the 4 px grid (master plan wave 4, DG).
 *
 * READ-ONLY, Demo company, dev only. The header toggle (`isaflow.tableDensity`) flips html[data-density]; in compact
 * the first body row of an ordinary list table is <= 34 px (py-1 cells), in comfortable it is the authored 49 px
 * for invoices, and it returns to 49 px when restored. Bank transaction and employee rows shrink. The income
 * statement's exempt grid row is the same height in both modes (it always runs: the P&L is exempt). Fixture tables in the
 * page assert the rule's reach by computed padding. The income statement's 4 px-grid share (the lfprobe `grid4` measure: padding/margin/gap values that are multiples of 4) is
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

  test('an exempt statement grid row (the income statement) is the same height in both modes', async ({ page }) => {
    const rowHeight = async (density: 'comfortable' | 'compact'): Promise<number> => {
      await open(page, '/accounting/reports/income-statement', density);
      const row = page.locator('table[data-density-exempt] tbody tr').first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      return (await row.boundingBox())!.height;
    };
    const comfortable = await rowHeight('comfortable');
    expect(Math.abs((await rowHeight('compact')) - comfortable)).toBeLessThanOrEqual(1);
  });

  // Real stylesheet, real computed style: fixture tables are mounted in the loaded page, so the production CSS
  // (compiled Tailwind utilities + the density rule) decides, not a source grep.
  test.describe('compact rule reach (computed padding in the loaded page)', () => {
    const FIXTURE = `<div id="dg-fixture">
      <table><thead><tr><th id="hd" class="py-3 px-4">H</th></tr></thead><tbody>
        <tr><td id="row" class="py-3 px-4">ordinary</td></tr>
        <tr><td id="empty" colspan="3" class="py-8 text-center">No rows</td></tr>
        <tr><td id="own" class="py-10 px-4">own padding</td></tr>
        <tr><td id="outer" class="py-3 px-4"><table data-density-exempt><tbody><tr><td id="nested" class="py-3 px-4">nested exempt</td></tr></tbody></table></td></tr>
      </tbody></table>
      <table data-density-exempt><tbody><tr><td id="exempt" class="py-3 px-4">exempt</td></tr></tbody></table>
      <table role="grid"><tbody><tr><td id="grid" class="py-3 px-4">grid</td></tr></tbody></table></div>`;
    const padding = async (page: Page): Promise<Record<string, number>> => page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const id of ['hd', 'row', 'empty', 'own', 'outer', 'nested', 'exempt', 'grid']) {
        const cs = getComputedStyle(document.getElementById(id)!);
        out[id] = parseFloat(cs.paddingTop);
      }
      return out;
    });
    const mount = async (page: Page, density: 'comfortable' | 'compact'): Promise<Record<string, number>> => {
      await open(page, '/accounting/customer-invoices', density);
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), FIXTURE);
      return padding(page);
    };

    test('compact: ordinary rows shrink; empty-state, own-padding, nested-exempt and exempt cells keep theirs', async ({ page }) => {
      const p = await mount(page, 'compact');
      expect(p.row).toBe(4);
      expect(p.hd).toBe(8);
      expect(p.empty).toBe(32);
      expect(p.own).toBe(40);
      expect(p.outer).toBe(4);
      expect(p.nested).toBe(12);
      expect(p.exempt).toBe(12);
      expect(p.grid).toBe(12);
    });

    test('comfortable: every cell keeps the authored padding', async ({ page }) => {
      const p = await mount(page, 'comfortable');
      expect([p.row, p.hd, p.outer, p.nested, p.exempt, p.grid]).toEqual([12, 12, 12, 12, 12, 12]);
      expect([p.empty, p.own]).toEqual([32, 40]);
    });
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
