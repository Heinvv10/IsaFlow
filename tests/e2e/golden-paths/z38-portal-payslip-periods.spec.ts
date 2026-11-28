// golden:dev-only
/**
 * Golden path (z38): the employee portal's payslip list shows every final slip under its own pay period (master plan
 * wave 7, PP; W14, RS1). Nothing is written, sent or invited: every portal read is page.route'd, and the server side
 * (the real list, tenancy, the weekly PDF's period line) is proven by tests/integration/w7-pp-portal-payslips.int.test.ts.
 *
 *  - a bonus slip, a weekly slip and a monthly slip are listed, each named by its period (also in the download link's
 *    accessible name, WCAG 2.5.3), under the "Pay period" column;
 *  - axe reports 0 critical and 0 serious, in both themes, at 1568 and 390. EVIDENCE_DIR=<dir> saves screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { guardDevTarget } from '../helpers/devTarget';

guardDevTarget(test);

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const SLIPS = [
  { runId: '00000000-0000-4000-8000-000000000038', periodYear: 2026, periodMonth: 11, periodLabel: 'Bonus, Nov 2026', runDate: '2026-11-27', netPay: 3700 },
  { runId: '00000000-0000-4000-8000-000000000037', periodYear: 2026, periodMonth: 11, periodLabel: 'Week 16–22 Nov 2026', runDate: '2026-11-20', netPay: 5099.77 },
  { runId: '00000000-0000-4000-8000-000000000036', periodYear: 2026, periodMonth: 10, periodLabel: 'October 2026', runDate: null, netPay: 25141.87 },
];

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

for (const theme of THEMES) {
  test(`portal payslip list: bonus, weekly and monthly slips under their own period, no serious axe violation (${theme})`, async ({ page }) => {
    await page.route('**/api/employee-portal/me', (route) => route.fulfill(ok({ employeeName: 'Zola Portal', employeeNumber: 'Z38-1', employer: 'Z38 Sandbox (Pty) Ltd' })));
    await page.route('**/api/employee-portal/payslips', (route) => route.fulfill(ok(SLIPS)));
    await page.route('**/api/employee-portal/leave', (route) => route.fulfill(ok([])));
    await page.route('**/api/employee-portal/irp5', (route) => route.fulfill(ok({ payFrequency: 'weekly', certificates: [] })));
    await seedTheme(page, theme);
    await page.goto('/employee-portal', { waitUntil: 'domcontentloaded' });
    const table = page.getByRole('table', { name: 'Your payslips, newest first' });
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(table.getByRole('columnheader', { name: 'Pay period' })).toBeVisible();
    const rows = await table.locator('tbody tr').allInnerTexts();
    expect(rows.map((r) => r.split('\t')[0])).toEqual(['Bonus, Nov 2026', 'Week 16–22 Nov 2026', 'October 2026']);
    for (const s of SLIPS) {
      await expect(page.getByRole('link', { name: `Download PDF for ${s.periodLabel}` })).toHaveAttribute('href', `/api/employee-portal/payslips/${s.runId}`);
    }
    await settle(page);
    for (const width of [1568, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/z38-portal-payslips-${theme}-${width}.png`, fullPage: true });
      expect(await seriousAxe(page), `axe ${theme} ${width}`).toEqual([]);
    }
  });
}
