// golden:dev-only
/**
 * Golden path (z19): no native selects on the screens that had them (master plan wave 5, UXN).
 *
 * READ-ONLY, Demo company, dev only. Nothing is written.
 *  - P&L filters, company settings (Details tab), the leave list and an employee profile have 0 native <select>
 *    (the journal-entry form is checked for 390 px overflow and axe only).
 *  - A picked kit Select value shows in its trigger (the P&L cost-centre filter keeps its choice).
 *  - Opening an invoice from a plain cell and pressing Escape returns focus to that row, not BODY.
 *  - No screen scrolls sideways at 390 px; axe reports 0 critical and 0 serious, in both themes.
 *  - UXN_EVIDENCE_DIR=<dir> saves a screenshot per screen, theme and width.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.UXN_EVIDENCE_DIR;
const SCREENS = [
  { slug: 'pnl', path: '/accounting/reports/income-statement' },
  { slug: 'company-settings', path: '/accounting/company-settings?tab=details' },
  { slug: 'leave', path: '/payroll/leave' },
  { slug: 'journal-new', path: '/accounting/journal-entries/new' },
] as const;

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
        const paths = [...SCREENS.map((s) => ({ slug: s.slug, path: s.path })), { slug: 'employee-profile', path: await profilePath(page) }];
        for (const s of paths) {
          await page.goto(s.path);
          await settle(page);
          // The journal's per-line Account selects are out of scope here: that page is in the list for its 390 px summary.
          if (s.slug !== 'journal-new') expect(await nativeSelects(page), `${s.slug}: native selects`).toBe(0);
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
      test.skip(!(await option.isVisible().catch(() => false)), 'Demo has no cost centres');
      const text = (await option.textContent()) ?? '';
      await option.click();
      await expect(box).toContainText(text.trim());
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
