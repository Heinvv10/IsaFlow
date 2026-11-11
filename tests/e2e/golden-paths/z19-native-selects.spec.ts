// golden:dev-only
/**
 * Golden path (z19): no native selects on the screens that had them (master plan wave 5, UXN).
 *
 * READ-ONLY, Demo company, dev only. Nothing is written.
 *  - P&L filters, company settings (Details tab), the leave list and an employee profile have 0 native <select>
 *    (the journal-entry form: its per-line Account selects too).
 *  - A picked kit Select value shows in its trigger (the P&L cost-centre filter keeps its choice).
 *  - Opening an invoice from a plain cell and pressing Escape returns focus to that row, not BODY.
 *  - Accounting settings (reporting currency) has 0 native selects; the invoice list is colour-contrast clean at 1280 px.
 *  - No screen scrolls sideways at 390 px; axe reports 0 critical and 0 serious, in both themes.
 *  - UXN_EVIDENCE_DIR=<dir> saves a screenshot per screen, theme and width.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { axeContrastFailures, seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.UXN_EVIDENCE_DIR;
/**
 * `ready`: kit comboboxes that must be on screen BEFORE the native-select count means anything. Counting zero on a page
 * that never rendered its controls would pass for the wrong reason, so each screen names the controls it replaced.
 */
const SCREENS = [
  { slug: 'pnl', path: '/accounting/reports/income-statement', ready: ['Cost Centre', 'Business Unit'] },
  { slug: 'company-settings', path: '/accounting/company-settings?tab=details', ready: ['Entity Type', 'Industry', 'Account Type', 'Document Type'] },
  { slug: 'leave', path: '/payroll/leave', ready: ['Filter by status', 'Filter by month'] },
  { slug: 'accounting-settings', path: '/accounting/accounting-settings', ready: ['Reporting Currency'] },
  { slug: 'journal-new', path: '/accounting/journal-entries/new', ready: ['Account, line 1', 'Account, line 2'] },
] as const;
const PROFILE_READY = ['Occupational level', 'Cost centre', 'Component']; // Pay package and Pay scale only render when the company has any

test.setTimeout(240_000);

async function snap(page: Page, slug: string, theme: string, width: number): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${slug}-${theme}-${width}.png`, fullPage: true });
}

const nativeSelects = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('select').length);
const overflowX = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
  expect(bad).toEqual([]);
}

async function profilePath(page: Page): Promise<string> {
  await page.goto('/payroll/employees');
  const link = page.locator('main a[href^="/payroll/employees/"]:not([href$="/new"]):not([href$="/bulk-update"])').first();
  await expect(link).toBeVisible({ timeout: 60_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/payroll\/employees\/[0-9a-f-]{36}$/);
  return href!;
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => { await seedTheme(page, theme); });

    for (const width of [1568, 390]) {
      test(`screens at ${width}px: 0 native selects, no sideways scroll, axe clean`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const paths = [...SCREENS, { slug: 'employee-profile', path: await profilePath(page), ready: PROFILE_READY }];
        for (const s of paths) {
          await page.goto(s.path);
          await settle(page);
          for (const name of s.ready) await expect(page.getByRole('combobox', { name, exact: true }), `${s.slug}: kit combobox "${name}" rendered`).toBeVisible({ timeout: 30_000 });
          if (s.slug === 'journal-new') await expect(page.getByRole('heading', { name: 'Balance Summary' })).toBeVisible();
          expect(await nativeSelects(page), `${s.slug}: native selects`).toBe(0);
          if (width === 390) expect(await overflowX(page), `${s.slug}: sideways overflow`).toBeLessThanOrEqual(0);
          await expectAxeClean(page);
          await snap(page, s.slug, theme, width);
        }
      });
    }

    test('a chosen P&L cost centre stays in its trigger', async ({ page }) => {
      await page.goto('/accounting/reports/income-statement');
      await settle(page);
      const box = page.getByRole('combobox', { name: 'Cost Centre' });
      await box.click();
      const option = page.getByRole('option').first();
      await expect(option, 'the cost-centre list opens with an option').toBeVisible({ timeout: 15_000 });
      const text = (await option.textContent()) ?? '';
      await option.click();
      await expect(box).toContainText(text.trim());
    });

    test('the invoice list passes axe colour-contrast at 1280px (the 90+ days label)', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/accounting/customer-invoices');
      await settle(page);
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
      expect(await axeContrastFailures(page)).toEqual([]);
    });

    test('Escape on the invoice drawer returns focus to the row that opened it', async ({ page }) => {
      await page.goto('/accounting/customer-invoices');
      await settle(page);
      const row = page.locator('tbody tr').first();
      await row.locator('td').nth(2).click();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(row).toBeFocused();
    });
  });
}
