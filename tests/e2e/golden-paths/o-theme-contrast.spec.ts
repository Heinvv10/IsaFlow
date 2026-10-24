/**
 * Golden path O — both themes meet WCAG AA on the main screens (master plan §3b.1).
 *
 * Each screen loads once per theme with the preference pre-seeded in localStorage, then
 * the page's computed colours are audited (tests/e2e/helpers/themeContrast.ts): 0 text
 * below 4.5:1 (3:1 for large text), and `color-scheme` follows the theme so native
 * select / date pop-ups render in it. Read-only: no data is written.
 *
 * Evidence mode: THEME_EVIDENCE_DIR=<dir> writes a screenshot per screen+theme and
 * contrast.json; THEME_RECORD_ONLY=1 additionally skips the assertions (for "before" runs).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { auditContrast, type ContrastReport } from '../helpers/themeContrast';

const SCREENS = [
  { slug: 'dashboard', path: '/accounting' },
  { slug: 'customer-invoices', path: '/accounting/customer-invoices' },
  { slug: 'customer-invoice-new', path: '/accounting/customer-invoices/new' },
  { slug: 'bank-transactions', path: '/accounting/bank-transactions' },
  { slug: 'payroll-employees', path: '/payroll/employees' },
  { slug: 'income-statement', path: '/accounting/reports/income-statement' },
  { slug: 'vat201', path: '/accounting/sars/vat201' },
  { slug: 'balance-sheet', path: '/accounting/reports/balance-sheet' },
  { slug: 'trial-balance', path: '/accounting/trial-balance' },
  { slug: 'general-ledger', path: '/accounting/reports/general-ledger' },
] as const;
const THEMES = ['light', 'dark'] as const;

const evidenceDir = process.env.THEME_EVIDENCE_DIR;
const recordOnly = process.env.THEME_RECORD_ONLY === '1';
const results: Record<string, ContrastReport> = {};

test.use({ viewport: { width: 1568, height: 765 } });
test.setTimeout(180_000);

async function settle(page: Page): Promise<void> {
  await page.waitForSelector('main', { timeout: 60_000 });
  await page.waitForFunction(
    () => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'),
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => document.fonts.ready);
}

for (const screen of SCREENS) {
  test(`${screen.slug}: AA contrast in light and dark`, async ({ page }) => {
    for (const theme of THEMES) {
      await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
      await settle(page);

      const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      const report = await auditContrast(page);
      results[`${screen.slug}.${theme}`] = report;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({ path: join(evidenceDir, `${screen.slug}-${theme}.png`) });
        writeFileSync(join(evidenceDir, `contrast-${screen.slug}.json`), JSON.stringify(
          Object.fromEntries(Object.entries(results).filter(([k]) => k.startsWith(`${screen.slug}.`))),
          null,
          2,
        ));
      }
      if (recordOnly) continue;

      expect(scheme, `${screen.slug} ${theme}: color-scheme`).toBe(theme);
      const detail = report.failing.slice(0, 8).map((f) => `${f.ratio}<${f.required} ${f.el} "${f.text}"`);
      expect(report.failing, `${screen.slug} ${theme}: text below AA\n${detail.join('\n')}`).toHaveLength(0);
    }
  });
}

// Master plan §3b.3: report grids scroll inside their own frame, with the header row and the
// first column pinned. Measured by scrolling the frame and checking where the cells ended up.
test.describe('reports pin the header row and the first column', () => {
  test.use({ viewport: { width: 760, height: 520 } });

  const REPORTS = [
    { slug: 'income-statement', path: '/accounting/reports/income-statement', widen: ['Budget', '12-month trend'] },
    { slug: 'trial-balance', path: '/accounting/trial-balance', widen: ['Show movement'] },
  ] as const;

  for (const report of REPORTS) {
    test(`${report.slug}: header stays at the top and the first column at the left`, async ({ page }) => {
      await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'light'));
      await page.goto(report.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      for (const label of report.widen) {
        const control = page.getByLabel(label).or(page.getByRole('button', { name: label }));
        await control.first().click();
      }
      await settle(page);

      const frame = page.locator('[data-sticky-frame]').first();
      await expect(frame).toBeVisible();
      const scrollable = await frame.evaluate((el) => ({ y: el.scrollHeight - el.clientHeight, x: el.scrollWidth - el.clientWidth }));
      expect(scrollable.y, 'the report must be tall enough to scroll or this proves nothing').toBeGreaterThan(40);
      expect(scrollable.x, 'the report must be wide enough to scroll sideways or this proves nothing').toBeGreaterThan(20);

      await frame.evaluate((el) => { el.scrollTop = 120; el.scrollLeft = 80; });
      const frameBox = await frame.boundingBox();
      const headBox = await frame.locator('thead th').first().boundingBox();
      const bodyCellBox = await frame.locator('tbody tr:visible td:first-child').nth(2).boundingBox();
      expect(frameBox && headBox && bodyCellBox).toBeTruthy();
      // Pinned: the header sits on the frame's top edge and the first column on its left edge,
      // although both were scrolled away from their natural place.
      expect(Math.abs(headBox!.y - frameBox!.y)).toBeLessThan(3);
      expect(Math.abs(headBox!.x - frameBox!.x)).toBeLessThan(3);
      expect(Math.abs(bodyCellBox!.x - frameBox!.x)).toBeLessThan(3);
    });
  }
});

// Master plan §3b.1: "System" follows the OS live, and a saved Light survives a full page load.
test.describe('theme preference in the browser', () => {
  const rootState = (page: Page) =>
    page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));

  test('System follows prefers-color-scheme without a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'system'));
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await rootState(page)).toEqual({ dark: true, scheme: 'dark' });

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => rootState(page)).toEqual({ dark: false, scheme: 'light' });
  });

  test('the header control switches theme and a saved Light survives a reload', async ({ page }) => {
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect.poll(() => rootState(page)).toEqual({ dark: false, scheme: 'light' });
    expect(await page.evaluate(() => window.localStorage.getItem('accounting-theme'))).toBe('light');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await rootState(page)).toEqual({ dark: false, scheme: 'light' });
    await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
