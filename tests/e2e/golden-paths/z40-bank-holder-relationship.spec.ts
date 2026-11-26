// golden:dev-only
/**
 * Golden path (z40): who holds the employee's bank account, e@syFile code 3246 (master plan wave 7 EA2; Hein's ruling
 * 26, migration 1062). The "Account held by" select on the profile's bank-details form and on New Employee's bank
 * section, in every state it has: a stated value (a change starts from it), cleared to "Not stated" (null), and open.
 *  - axe reports 0 critical and 0 serious, in both themes, at 1568 and 390, and no sideways scroll at 390.
 *    EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Nothing is saved: the bank-details read is a page.route'd masked answer (the server side is
 * tests/integration/w7-ea2-easyfile-contacts.int.test.ts and the unit tests), and no form is submitted. Dev only: it
 * writes one employee in its own sandbox company, never in Demo.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Bank Holder Sandbox', onboardingId: 'e40b7c1d-5a2e-4f9b-8c3d-1f6a2b9e7d40' };
const EMPLOYEE = { employeeNumber: 'Z40-1', firstName: 'Zola', lastName: 'Holder' };
const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

let sandboxId = '';
let employeeId = '';

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function checkWidths(page: Page, name: string, theme: string, shot: Locator): Promise<void> {
  await settle(page);
  for (const width of [1568, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await shot.scrollIntoViewIfNeeded();
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}-${width}.png` });
    expect(await seriousAxe(page), `axe ${name} ${theme} ${width}`).toEqual([]);
    if (width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} sideways scroll at 390`).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1568, height: 1000 });
}

test.beforeAll(async ({ baseURL }) => {
  const u = new URL(baseURL!);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z40 writes payroll data: dev/CI localhost only, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL!);
  try {
    sandboxId = await findOrCreateSandbox(api, SANDBOX);
    await switchApiCompany(api, sandboxId);
    const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
    employeeId = existing.find((e) => e.employeeNumber === EMPLOYEE.employeeNumber)?.id
      ?? (await api.post<{ id: string }>('/api/payroll/employees', { ...EMPLOYEE, employmentType: 'permanent', startDate: '2024-01-01' })).id;
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`profile: the bank-details form's "Account held by", stated, cleared and open (${theme})`, async ({ page, context }) => {
    await switchBrowserCompany(context, sandboxId);
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/bank-details')) puts.push(r.url()); });
    await page.route('**/api/payroll/employees/*/bank-details*', (route) => (route.request().method() === 'GET'
      ? route.fulfill(ok({
        id: '40404040-4040-4040-8040-404040404040', employeeId, bankName: 'FNB', accountNumber: '…0001', masked: true,
        accountType: 'cheque', branchCode: '…55', accountHolder: null, accountHolderRelationship: 'joint', effectiveFrom: '2026-11-01',
      }))
      : route.continue()));
    await seedTheme(page, theme);
    await page.goto(`/payroll/employees/${employeeId}`);
    const card = page.getByTestId('employee-bank-card');
    await expect(card.getByText('Joint account')).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: 'Change bank details' }).click();
    const select = card.getByRole('combobox', { name: /Account held by/ });
    await expect(select).toContainText('Joint account');
    await checkWidths(page, 'z40-bank-form-stated', theme, card);

    await card.getByRole('button', { name: 'Clear selection' }).click();
    await expect(select).toContainText('Not stated');
    await checkWidths(page, 'z40-bank-form-not-stated', theme, card);

    await select.click();
    await expect(page.getByRole('option', { name: 'Someone else (third party)' })).toBeVisible();
    await checkWidths(page, 'z40-bank-form-open', theme, card);
    await page.keyboard.press('Escape');
    expect(puts).toEqual([]);
  });

  test(`New Employee: the bank section's "Account held by", not stated and open (${theme})`, async ({ page, context }) => {
    await switchBrowserCompany(context, sandboxId);
    await seedTheme(page, theme);
    await page.goto('/payroll/employees/new');
    await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 90_000 });
    const select = page.getByRole('combobox', { name: /Account held by/ });
    await expect(select).toContainText('Not stated');
    await checkWidths(page, 'z40-create-bank-not-stated', theme, select);
    await select.click();
    await expect(page.getByRole('option', { name: 'The employee (own account)' })).toBeVisible();
    await checkWidths(page, 'z40-create-bank-open', theme, select);
    await page.keyboard.press('Escape');
  });
}
