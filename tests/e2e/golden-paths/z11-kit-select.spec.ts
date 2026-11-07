/**
 * Golden path Z11 - the kit Select by keyboard, on the invoice editor and list (master plan wave 4, PR NS1).
 *
 * A keyboard-only invoice: the revenue account and the job are chosen with Enter, the arrow keys and Enter (no mouse),
 * saved, and the API holds both ids. The list's search is found by its label "Search invoices". The invoice new, edit
 * and list pages draw no native select. axe reports nothing serious or critical in either theme.
 */
// golden:dev-only
// Dev only: it creates a project and a draft invoice in a sandbox company and runs axe. The post-deploy run skips it by this marker.
import { expect, test, type Page } from '@playwright/test';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NEW = '/accounting/customer-invoices/new';
const LIST = '/accounting/customer-invoices';
// Shares y1/z1's sandbox: one company for the invoice form.
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a';
const JOB = '0GP Golden Select Job';

async function open(page: Page, url: string, heading: RegExp | string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

/** Enter opens the list, `down` arrows move, Enter chooses: no mouse. */
async function chooseByKeys(page: Page, name: string, down: number): Promise<void> {
  await page.getByRole('combobox', { name, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  for (let i = 0; i < down; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

const nativeSelects = (page: Page) => page.locator('select').count();

test('keyboard only: account and job chosen by keys, saved, and the API holds both', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const clientId = await api.fixtureCustomer();
  const projects = await api.get<{ id: string; name: string }[]>('/api/accounting/projects');
  if (!projects.some((p) => p.name === JOB)) await api.post('/api/accounting/projects', { name: JOB, clientId });
  await open(page, NEW, 'Customer Invoice');

  await page.getByRole('combobox', { name: 'Client' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('0GP-Golden');
  await expect(page.getByRole('option', { name: '0GP-Golden-Customer' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.getByPlaceholder('Item description').fill(`Z11 keyboard ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('100');
  // Row 0 of the list is "Default sales": two arrows land on the first real account.
  await chooseByKeys(page, 'Revenue account', 2);
  await expect(page.getByRole('combobox', { name: 'Revenue account' })).not.toContainText('Default sales');
  await page.getByRole('button', { name: /Dimensions/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Job (Project Profitability)' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type(JOB.slice(0, 12)); // the search box filters to the job
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Job (Project Profitability)' })).toContainText(JOB);
  expect(await nativeSelects(page), 'invoice new draws no native select').toBe(0);

  await page.getByRole('button', { name: /^create invoice$/i }).click();
  await page.waitForURL(/\/accounting\/customer-invoices\/(?!new)[0-9a-f-]{36}/, { timeout: 30_000 });
  const id = /customer-invoices\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  try {
    const inv = await api.get<{ items: { gl_account_id: string | null; project_id: string | null }[] }>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(inv.items[0]!.gl_account_id, 'the account chosen by keys is saved').toBeTruthy();
    expect(inv.items[0]!.project_id, 'the job chosen by keys is saved').toBeTruthy();
    await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('combobox', { name: 'Revenue account' }).first()).toBeVisible({ timeout: 60_000 });
    expect(await nativeSelects(page), 'invoice edit draws no native select').toBe(0);
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('list: the search is found by its label and no native select is drawn', async ({ page }) => {
  await open(page, LIST, /Tax Invoices/);
  await expect(page.getByLabel('Search invoices')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
  expect(await nativeSelects(page)).toBe(0);
});

for (const theme of THEMES) {
  test(`axe: no serious or critical violation on invoice new and list (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await open(page, NEW, 'Customer Invoice');
    await expectNoSeriousA11yViolations(page, { key: NEW });
    await open(page, LIST, /Tax Invoices/);
    await expectNoSeriousA11yViolations(page, { key: LIST });
  });
}

