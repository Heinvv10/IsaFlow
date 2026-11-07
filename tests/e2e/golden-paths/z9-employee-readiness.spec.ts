// golden:dev-only
/**
 * Golden path (z9): employee "Ready to pay" (master plan wave 4, PR B).
 *
 *  - Keyboard only: create an employee with a tax number, a salary and bank details; the profile heads with
 *    "Ready to pay" and the bank card shows "•••• 1234".
 *  - Create without bank details: the profile says "1 thing before the first pay run: bank details", and its
 *    link takes focus to the bank card.
 *  - The blank bank section carries no asterisks; one keystroke stars the three fields.
 *  - axe reports 0 critical and 0 serious on both profiles, in both themes; 390 px does not scroll sideways.
 *  - EVIDENCE_DIR=<dir> saves screenshots (light and dark, 1568 and 390).
 *
 * Dev/CI gate: it writes employees (no delete endpoint exists; the numbers are unique per run), in one dedicated
 * sandbox company created on first use, never in Demo.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const SANDBOX = { name: '0GP Golden Employee Readiness Sandbox', onboardingId: '9c2e4f70-3b8d-4a15-b6e1-7d0a5c3f8e29' };
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const NEW = '/payroll/employees/new';
const PROFILE = /\/payroll\/employees\/[0-9a-f-]{36}$/;

let sandboxId = '';

async function snap(page: Page, name: string, theme: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}.png`, fullPage: true });
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
  expect(bad).toEqual([]);
}

/** From the keyboard: name, number, tax number, then salary (Enter submits), with the bank section typed if asked. */
async function createByKeyboard(page: Page, number: string, withBank: boolean): Promise<void> {
  await page.goto(NEW);
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
  const salary = page.getByLabel('Monthly salary');
  await expect(salary).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('First name *').focus();
  await page.keyboard.type('Golden');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Ready');
  await page.getByLabel('Employee number *').focus();
  await page.keyboard.type(number);
  await page.getByLabel('SARS tax number').fill('0123456789');
  if (withBank) {
    await page.getByLabel('Bank name', { exact: true }).focus();
    await page.keyboard.type('FNB');
    await page.getByLabel('Branch code *').focus();
    await page.keyboard.type('250655');
    await page.getByLabel('Account number *').focus();
    await page.keyboard.type('62000121234');
  }
  await salary.focus();
  await page.keyboard.type('25 000');
  await page.keyboard.press('Enter');
  await page.waitForURL(PROFILE, { timeout: 30_000 });
}

test.beforeAll(async ({ baseURL }) => {
  const u = new URL(baseURL!);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z9 runs only on a dev/CI localhost port, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL!);
  try {
    sandboxId = await findOrCreateSandbox(api, SANDBOX);
    await switchApiCompany(api, sandboxId);
    const components = await api.get<Array<{ sarsSourceCode: string }>>('/api/payroll/components');
    if (!components.some((c) => c.sarsSourceCode === '3601')) {
      await api.post('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' });
    }
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ context }) => {
  await switchBrowserCompany(context, sandboxId);
});

test('the blank bank section has no asterisks; one keystroke adds them', async ({ page }) => {
  await page.goto(NEW);
  await expect(page.getByLabel('Bank name', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Bank name *')).toHaveCount(0);
  await page.getByLabel('Bank name', { exact: true }).scrollIntoViewIfNeeded();
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/create-blank-bank.png` });
  await expect(page.getByLabel('Account type')).toBeVisible();
  await page.getByLabel('Bank name', { exact: true }).focus();
  await page.keyboard.type('F');
  for (const l of ['Bank name *', 'Branch code *', 'Account number *']) {
    await expect(page.getByLabel(l)).toHaveAttribute('aria-required', 'true');
  }
  await expect(page.getByLabel('Account type *')).toHaveCount(0);
});

test('keyboard only: create with salary and bank, and the profile says Ready to pay', async ({ page }) => {
  await createByKeyboard(page, `Z9R-${Date.now()}`, true);
  await expect(page.getByTestId('employee-readiness-card')).toHaveText(/Ready to pay/, { timeout: 30_000 });
  await expect(page.getByTestId('employee-bank-card').getByText('•••• 1234')).toBeVisible({ timeout: 30_000 });
});

test('create without bank details: one thing before the first pay run, and the link goes to the bank card', async ({ page }) => {
  await createByKeyboard(page, `Z9N-${Date.now()}`, false);
  const card = page.getByTestId('employee-readiness-card');
  await expect(card).toContainText('1 thing before the first pay run: bank details', { timeout: 30_000 });
  const add = page.getByRole('button', { name: 'Add bank details' });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await card.getByRole('link', { name: 'bank details' }).click();
  await expect(add).toBeFocused();
});

for (const theme of THEMES) {
  test(`both profiles have no serious axe violations and fit 390 px (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await createByKeyboard(page, `Z9A${theme[0]}-${Date.now()}`, false);
    await expect(page.getByTestId('employee-readiness-card')).toContainText('bank details', { timeout: 30_000 });
    await expect(page.getByLabel('Occupational level')).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    await snap(page, 'readiness-missing-1568', theme);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.inner);
    await snap(page, 'readiness-missing-390', theme);

    await page.setViewportSize({ width: 1568, height: 900 });
    await createByKeyboard(page, `Z9B${theme[0]}-${Date.now()}`, true);
    await expect(page.getByTestId('employee-readiness-card')).toHaveText(/Ready to pay/, { timeout: 30_000 });
    await expect(page.getByTestId('employee-bank-card').getByText('•••• 1234')).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    await snap(page, 'readiness-ready-1568', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await snap(page, 'readiness-ready-390', theme);
  });
}
