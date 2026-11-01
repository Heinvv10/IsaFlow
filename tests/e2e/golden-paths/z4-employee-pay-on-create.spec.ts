// golden:dev-only
/**
 * Golden path (z4): one flow to ready to pay (master plan wave 3, PR W).
 *
 *  - Keyboard only: a refused tax number stops the form on the field; Tab reports a bad one before any submit; the pay
 *    component is chosen from the keyboard; Enter in the salary box creates the employee and the profile shows
 *    R 25 000. Enter is the awkward path: the amount is committed by that same key press.
 *  - The drawer opens from the list by keyboard and by a row click, and shows their pay.
 *  - axe reports 0 critical and 0 serious on the form and on the open drawer, in both themes, and neither scrolls
 *    sideways at 390. EVIDENCE_DIR=<dir> saves screenshots (light and dark, 1568 and 390).
 *
 * Dev/CI gate: it writes employees (no delete endpoint exists; the numbers are unique per run), in one dedicated
 * sandbox company created on first use, never in Demo.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const SANDBOX = { name: '0GP Golden Employee Sandbox', onboardingId: '67a6e8ca-634d-4bd2-bd93-dbfe73b22ff9' };
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const NEW = '/payroll/employees/new';
const LIST = '/payroll/employees';
const RANDS = /R\s?25[\s ,]?000/;
const KEYBOARD_COMPONENT = 'Z4 Commission';

let sandboxId = '';
let listed = '';

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

/** The app scrolls an inner pane, so a full-page shot stops above the Pay section: bring it into the viewport. */
async function snapField(page: Page, name: string, theme: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  await page.getByLabel('Monthly salary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png` });
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
  expect(bad).toEqual([]);
}

async function expectNoSideScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
}

test.beforeAll(async ({ baseURL }) => {
  // Creates a company: never production, not app.isaflow.co.za and not this box's prod next-server on :3101.
  const u = new URL(baseURL!);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z4 runs only on a dev/CI localhost port, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL!);
  try {
    sandboxId = await findOrCreateSandbox(api, SANDBOX);
    await switchApiCompany(api, sandboxId);
    const components = await api.get<Array<{ id: string; name: string; sarsSourceCode: string }>>('/api/payroll/components');
    const basic = components.find((c) => c.sarsSourceCode === '3601')
      ?? await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' });
    // One employee with pay for the drawer tests, made through the route the form posts to.
    listed = `Listed${Date.now()}`;
    if (!components.some((c) => c.name === KEYBOARD_COMPONENT)) {
      await api.post('/api/payroll/components', { name: KEYBOARD_COMPONENT, sarsSourceCode: '3606', componentType: 'earning' });
    }
    await api.post('/api/payroll/employees', {
      firstName: 'Golden', lastName: listed, employeeNumber: `Z4L-${Date.now()}`, employmentType: 'permanent', startDate: '2026-11-01',
      salary: { componentId: basic.id, amountCents: 2_500_000 },
    });
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ context }) => {
  await switchBrowserCompany(context, sandboxId);
});

test('keyboard only: create an employee with a salary, and the profile shows it', async ({ page }) => {
  const number = `Z4-${Date.now()}`;
  await page.goto(NEW);
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
  const salary = page.getByLabel('Monthly salary');
  await expect(salary).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('combobox', { name: 'Pay component' })).toContainText('3601');

  await page.getByLabel('First name *').focus();
  await page.keyboard.type('Golden');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Pay');
  await page.getByLabel('Employee number *').focus();
  await page.keyboard.type(number);

  const tax = page.getByLabel('SARS tax number');
  await tax.focus();
  await page.keyboard.type('4123456789');
  await page.keyboard.press('Enter');
  await expect(tax).toHaveAttribute('aria-invalid', 'true');
  await expect(tax).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(NEW);
  await tax.fill('');
  await page.keyboard.type('4123456789');
  await page.keyboard.press('Tab');
  await expect(tax).toHaveAttribute('aria-invalid', 'true'); // on leaving the field, with no submit
  await tax.fill('0123456789');

  const picker = page.getByRole('combobox', { name: 'Pay component' });
  await picker.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Z4');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText(KEYBOARD_COMPONENT);
  await expect(picker).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('3601');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('3601');

  await salary.focus();
  await page.keyboard.type('25 000');
  await page.keyboard.press('Enter'); // commits the amount and submits, on one key press
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  await expect(page.getByRole('heading', { name: 'Pay Components' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('section', { hasText: 'Pay Components' }).getByText(RANDS).first()).toBeVisible({ timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const res = await page.request.get(`/api/payroll/employees/${id}/components`);
  expect(res.status()).toBe(200);
  const rows = ((await res.json()) as { data: Array<{ amount: number; isRecurring: boolean }> }).data;
  expect(rows.map((r) => [r.amount, r.isRecurring])).toEqual([[25000, true]]);
});

test('the drawer opens from the list, by keyboard and by a row click', async ({ page }) => {
  await page.goto(LIST);
  const row = page.getByRole('row', { name: new RegExp(listed) });
  await expect(row).toBeVisible({ timeout: 30_000 });

  const quickView = row.getByRole('button', { name: `Quick view of Golden ${listed}` });
  await quickView.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Basic Salary')).toBeVisible();
  await expect(drawer.getByText(RANDS)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(quickView).toBeFocused();

  await row.getByRole('cell', { name: /permanent/i }).click();
  await expect(drawer.getByText(RANDS)).toBeVisible();
  await drawer.getByRole('link', { name: 'Open full profile' }).click();
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/, { timeout: 30_000 });
});

for (const theme of THEMES) {
  test(`the form and the drawer have no serious axe violations and fit 390 px (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(NEW);
    await expect(page.getByLabel('Monthly salary')).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    await snapField(page, 'employee-pay-1568', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoSideScroll(page);
    await expectAxeClean(page);
    await snapField(page, 'employee-pay-390', theme);

    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(LIST);
    const row = page.getByRole('row', { name: new RegExp(listed) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('cell', { name: /permanent/i }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(RANDS)).toBeVisible();
    await expectAxeClean(page);
    await snap(page, 'employee-drawer-1568', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoSideScroll(page);
    await expect(drawer.getByRole('link', { name: 'Open full profile' })).toBeInViewport();
    await expectAxeClean(page);
    await snap(page, 'employee-drawer-390', theme);
  });

  test(`at 390 a row tap opens the drawer and the table scrolls on its own (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(LIST);
    const row = page.getByRole('row', { name: new RegExp(listed) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectNoSideScroll(page);
    await snap(page, 'employee-list-390', theme);
    // The Status and action columns are past the edge: they must be reachable, not clipped.
    const frame = row.locator('xpath=ancestor::table/parent::div');
    expect(await frame.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    await row.getByRole('cell').first().click(); // Emp #: no link in it
    await expect(page.getByRole('dialog').getByText(RANDS)).toBeVisible();
  });
}
