// golden:dev-only
/**
 * Golden path (y3): employee create on the form kit, and payroll runs at 390 (master plan wave 2, PR E).
 *
 *  - Keyboard only: label focus + typing + Tab/Enter creates an employee and lands on its page.
 *  - axe reports 0 critical and 0 serious on /payroll/employees/new, in both themes (no baseline entry).
 *  - At 390x844, /payroll/runs does not scroll sideways and shows a card with "Net".
 *  - EVIDENCE_DIR=<dir> saves screenshots (light and dark, 1568 and 390).
 *
 * Dev/CI gate: it creates an employee (no delete endpoint exists; the number is unique per run), so it does not run in
 * the post-deploy check against production.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const NEW = '/payroll/employees/new';

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

test('keyboard only: create an employee from the kit form', async ({ page }) => {
  const number = `Y3-${Date.now()}`;
  await page.goto(NEW);
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('First name *').focus();
  await page.keyboard.type('Golden');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Kit');
  await page.getByLabel('Employee number *').focus();
  await page.keyboard.type(number);

  // Submitting with a refused start date shows the error on the field and does not post.
  const start = page.getByLabel(/^Start date/);
  await start.fill('31 Feb 2026');
  await page.keyboard.press('Enter');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await expect(start).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(NEW);

  await start.fill('t');
  await page.keyboard.press('Tab'); // commits "t" to today
  await page.getByLabel('First name *').focus();
  await page.keyboard.press('Enter'); // implicit submit
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  const id = new URL(page.url()).pathname.split('/').pop()!;
  const res = await page.request.get(`/api/payroll/employees/${id}`);
  expect(res.status()).toBe(200);
  const created = ((await res.json()) as { data?: Record<string, string> }).data!;
  expect(created.employeeNumber).toBe(number);
  expect(created.firstName).toBe('Golden');
});

for (const theme of THEMES) {
  test(`employee create has no serious axe violations (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(NEW);
    await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
    expect(bad).toEqual([]);
    await snap(page, 'employee-new-1568', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, 'employee-new-390', theme);
  });

  test(`payroll runs fit 390 px with cards (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/payroll/runs');
    await expect(page.getByRole('heading', { name: 'Payroll Runs', exact: true })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    const cards = page.getByRole('list', { name: 'Payroll runs' });
    await expect(cards.getByText('Net').first()).toBeVisible();
    await expect(page.locator('main table')).toBeHidden();
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.inner);
    await snap(page, 'runs-390', theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await expect(page.locator('main table')).toBeVisible();
    await snap(page, 'runs-1568', theme);
  });
}
