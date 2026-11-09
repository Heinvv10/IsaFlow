// golden:dev-only
/**
 * Golden path (z5): employee bank details (master plan wave 3, K2).
 *
 *  - Create an employee with bank details on the form: the profile shows "•••• 1234" and who changed it last.
 *  - The page only ever reads the masked view (?view=masked) and the full number is nowhere in the page.
 *  - The card's history timeline holds a change row with the masked account number.
 *  - An owner / admin changes the details from the card; the card then shows the new last four, and the history
 *    holds the old masked number and the new one (across the retired row), with no employee uuid and no Reveal.
 *  - axe reports 0 critical and 0 serious on the create form (with its bank section), on the profile, on the open
 *    change form and on its field-error state, both themes.
 *  - EVIDENCE_DIR=<dir> saves screenshots (light and dark).
 *
 * Dev/CI gate: it writes employees (no delete endpoint exists; the numbers are unique per run), in one dedicated
 * sandbox company created on first use, never in Demo.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const SANDBOX = { name: '0GP Golden Employee Bank Sandbox', onboardingId: '5d1b7c0e-8a2f-4e63-9b14-3c7a6f2d9e58' };
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const NEW = '/payroll/employees/new';
const PROFILE = /\/payroll\/employees\/[0-9a-f-]{36}$/;
const FULL = '62000121234';
const CHANGED = '1357925678';

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

async function fillEmployeeAndBank(page: Page, number: string, account: string): Promise<void> {
  await page.getByLabel('First name *').fill('Golden');
  await page.getByLabel('Last name *').fill('Bank');
  await page.getByLabel('Employee number *').fill(number);
  // The section is optional while blank: no asterisk until something is typed (wave 4 B).
  await page.getByLabel('Bank name', { exact: true }).fill('FNB');
  await page.getByLabel('Branch code *').fill('250655');
  await page.getByLabel('Account number *').fill(account);
  await page.getByLabel('Account holder').fill('Golden Bank');
}

test.beforeAll(async ({ baseURL }) => {
  const u = new URL(baseURL!);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z5 runs only on a dev/CI localhost port, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL!);
  try {
    sandboxId = await findOrCreateSandbox(api, SANDBOX);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ context }) => {
  await switchBrowserCompany(context, sandboxId);
});

test('create with bank details: the profile shows the masked number and the last change, and the page never reads the full one', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/bank-details')) reads.push(r.url()); });
  await page.goto(NEW);
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
  await fillEmployeeAndBank(page, `Z5-${Date.now()}`, FULL);
  await page.getByRole('button', { name: 'Create Employee' }).click();
  await page.waitForURL(PROFILE, { timeout: 30_000 });

  const card = page.getByTestId('employee-bank-card');
  await expect(card.getByText('•••• 1234')).toBeVisible({ timeout: 30_000 });
  // The profile now carries the work terms card (mig 967) beside the bank card; neither hides the other.
  await expect(page.getByTestId('employee-work-card').getByRole('heading', { name: 'Work terms' })).toBeVisible();
  const summary = card.locator('dl');
  await expect(summary.getByText('FNB')).toBeVisible();
  await expect(summary.getByText('…55')).toBeVisible();
  await expect(card.getByTestId('bank-last-change')).toHaveText(/^Changed (just now|\d+ minutes? ago) by \S+/, { timeout: 30_000 });
  const history = card.getByTestId('bank-history').getByTestId('entity-change');
  await expect(history).toHaveCount(1, { timeout: 30_000 });
  await expect(history.first()).toContainText('Account number');
  await expect(history.first()).toContainText('…1234');
  expect(await page.content()).not.toContain(FULL);
  expect(reads.length).toBeGreaterThan(0);
  for (const url of reads) expect(url).toContain('view=masked');
});

test('an owner / admin changes the details from the card', async ({ page }) => {
  await page.goto(NEW);
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 30_000 });
  await fillEmployeeAndBank(page, `Z5C-${Date.now()}`, FULL);
  await page.getByRole('button', { name: 'Create Employee' }).click();
  await page.waitForURL(PROFILE, { timeout: 30_000 });
  const card = page.getByTestId('employee-bank-card');
  await expect(card.getByText('•••• 1234')).toBeVisible({ timeout: 30_000 });
  const history = card.getByTestId('bank-history');
  await expect(history).toContainText('…1234', { timeout: 30_000 });

  await card.getByRole('button', { name: 'Change bank details' }).click();
  await expect(card.getByLabel('Account number *')).toHaveValue('');
  await card.getByLabel('Branch code *').fill('12');
  await card.getByRole('button', { name: 'Save bank details' }).click();
  await expect(card.getByLabel('Branch code *')).toHaveAttribute('aria-invalid', 'true');
  await card.getByLabel('Branch code *').fill('470010');
  await card.getByLabel('Account number *').fill(CHANGED);
  await card.getByRole('button', { name: 'Save bank details' }).click();
  // The details name a holder, so a change has to type it again rather than silently clear it.
  await expect(card.getByLabel('Account holder', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await card.getByLabel('Account holder', { exact: true }).fill('Golden Bank');
  await card.getByRole('button', { name: 'Save bank details' }).click();
  await expect(card.getByText('•••• 5678')).toBeVisible({ timeout: 30_000 });
  // The history spans the retired row too: the old and the new account are both on the profile, with no uuid and no Reveal.
  await expect(history).toContainText('…5678', { timeout: 30_000 });
  await expect(history).toContainText('…1234');
  await expect(history).toContainText('Cheque / current');
  await expect(history).not.toContainText(/Employee\s+[0-9a-f]{8}-/);
  await expect(history.getByText(/Reveal/)).toHaveCount(0);
});

for (const theme of THEMES) {
  test(`create form with the bank section and the profile have no serious axe violations (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(NEW);
    await expect(page.getByLabel('Bank name', { exact: true })).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    await snap(page, 'employee-bank-form', theme);

    await fillEmployeeAndBank(page, `Z5A${theme[0]}-${Date.now()}`, FULL);
    await page.getByRole('button', { name: 'Create Employee' }).click();
    await page.waitForURL(PROFILE, { timeout: 30_000 });
    await expect(page.getByTestId('employee-bank-card').getByText('•••• 1234')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('bank-last-change')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Occupational level')).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    await snap(page, 'employee-bank-profile', theme);

    const card = page.getByTestId('employee-bank-card');
    await card.getByRole('button', { name: 'Change bank details' }).click();
    await expect(card.getByLabel('Account number *')).toBeVisible();
    await expectAxeClean(page);
    await snap(page, 'employee-bank-change-form', theme);
    await card.getByLabel('Branch code *').fill('12');
    await card.getByRole('button', { name: 'Save bank details' }).click();
    await expect(card.getByLabel('Branch code *')).toHaveAttribute('aria-invalid', 'true');
    await expectAxeClean(page);
    await snap(page, 'employee-bank-change-errors', theme);
  });
}
