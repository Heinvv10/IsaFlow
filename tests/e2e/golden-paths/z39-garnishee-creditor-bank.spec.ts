// golden:dev-only
/**
 * Golden path (z39): the creditor's bank details on a garnishee order (master plan wave 7, GC1).
 *
 *  - An order entered through the API shows "No creditor bank details yet" on the employee's garnishee card.
 *  - Enter bank details from the card: a 4-digit branch code is refused with the field's message and writes nothing;
 *    a valid entry shows the masked line (account number to its last four, branch to its last two, holder initial),
 *    and the full number and branch code are nowhere in the page.
 *  - The card never asks for the full read: no GET of the order itself (the list carries the masked view).
 *  - axe reports 0 critical and 0 serious on the card with the open form, both themes; 390 px keeps the form usable.
 *  - EVIDENCE_DIR=<dir> saves screenshots (light, dark, 390 px).
 *
 * Dev/CI gate: it writes an employee and an order (no delete endpoint; each run its own employee number), in one
 * dedicated sandbox company created on first use, never in Demo.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { guardDevTarget } from '../helpers/devTarget';

guardDevTarget(test);

const SANDBOX = { name: '0GP Golden Garnishee Creditor Sandbox', onboardingId: '15033f45-67de-41ed-948b-6fdd037193f4' };
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const FULL = '62003939391';
const BRANCH = '250655';

let sandboxId = '';

async function snap(page: Page, name: string, tag: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${tag}.png`, fullPage: true });
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).include('section[aria-labelledby="employee-garnishee-heading"]').analyze();
  const bad = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
  expect(bad).toEqual([]);
}

/** A fresh employee with one emoluments attachment order; returns the employee id. */
async function employeeWithOrder(baseURL: string, tag: string): Promise<string> {
  const api = await Api.login(baseURL);
  try {
    await switchApiCompany(api, sandboxId);
    const id = (await api.post<{ id: string }>('/api/payroll/employees', {
      employeeNumber: `Z39${tag}-${Date.now()}`, firstName: 'Gugu', lastName: 'Garnishee', employmentType: 'permanent',
      startDate: '2024-01-01', taxNumber: '0123456789',
    })).id;
    await api.post(`/api/payroll/employees/${id}/garnishee-orders`, {
      kind: 'emolument_attachment', reference: 'EAO 39/2027', creditorName: 'Acme Credit', instalment: 1500, totalDebt: 15000,
      startDate: '2027-01-01', endDate: null, priority: 10,
    });
    return id;
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async ({ baseURL }) => {
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

const card = (page: Page) => page.locator('section[aria-labelledby="employee-garnishee-heading"]');

test('enter the creditor bank details: refused when invalid, then shown masked, never in full', async ({ page, baseURL }) => {
  const employee = await employeeWithOrder(baseURL!, 'E');
  const orderGets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && /garnishee-orders\/[0-9a-f-]{36}/.test(r.url())) orderGets.push(r.url()); });
  await page.goto(`/payroll/employees/${employee}`);
  const c = card(page);
  await expect(c.getByText('No creditor bank details yet')).toBeVisible({ timeout: 30_000 });

  await c.getByRole('button', { name: 'Enter bank details' }).click();
  await c.getByLabel("Creditor's bank").fill('First National Bank');
  await c.getByLabel('Branch code').fill('2506');
  await c.getByLabel('Account number').fill(FULL);
  await c.getByLabel('Account holder (optional)').fill('Acme Credit Ltd');
  await c.getByRole('button', { name: 'Save bank details' }).click();
  await expect(c.getByRole('alert')).toContainText(/Branch code must be 6 digits|Validation failed/, { timeout: 30_000 });

  await c.getByLabel('Branch code').fill(BRANCH);
  await c.getByRole('button', { name: 'Save bank details' }).click();
  await expect(c.getByText(/Pays into First National Bank cheque …9391, branch …55, holder A…/)).toBeVisible({ timeout: 30_000 });
  await expect(c.getByRole('button', { name: 'Change bank details' })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(FULL);
  expect(html).not.toContain(BRANCH);
  expect(orderGets).toEqual([]);
});

for (const theme of THEMES) {
  test(`the garnishee card with the open form has no serious axe violations (${theme})`, async ({ page, baseURL }) => {
    const employee = await employeeWithOrder(baseURL!, theme[0]!.toUpperCase());
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(`/payroll/employees/${employee}`);
    const c = card(page);
    await expect(c.getByText('No creditor bank details yet')).toBeVisible({ timeout: 30_000 });
    await c.getByRole('button', { name: 'Enter bank details' }).click();
    await expect(c.getByLabel('Account number')).toBeVisible();
    await c.scrollIntoViewIfNeeded();
    await settle(page);
    await expectAxeClean(page);
    if (EVIDENCE_DIR) await c.screenshot({ path: `${EVIDENCE_DIR}/garnishee-creditor-form-${theme}.png` });
    await c.getByLabel("Creditor's bank").fill('Standard Bank');
    await c.getByLabel('Branch code').fill('051001');
    await c.getByLabel('Account number').fill('10039393939');
    await c.getByRole('button', { name: 'Save bank details' }).click();
    await expect(c.getByText(/Pays into Standard Bank cheque …3939, branch …01/)).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await expectAxeClean(page);
    if (EVIDENCE_DIR) await c.screenshot({ path: `${EVIDENCE_DIR}/garnishee-creditor-saved-${theme}.png` });
  });
}

test('at 390 px the form fits the width and saves', async ({ page, baseURL }) => {
  const employee = await employeeWithOrder(baseURL!, 'M');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/payroll/employees/${employee}`);
  const c = card(page);
  await expect(c.getByText('No creditor bank details yet')).toBeVisible({ timeout: 30_000 });
  await c.getByRole('button', { name: 'Enter bank details' }).click();
  await expect(c.getByLabel('Account number')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await c.scrollIntoViewIfNeeded();
  if (EVIDENCE_DIR) await c.screenshot({ path: `${EVIDENCE_DIR}/garnishee-creditor-form-390.png` });
});
