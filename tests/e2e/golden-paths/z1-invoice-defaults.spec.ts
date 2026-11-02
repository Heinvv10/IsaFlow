/**
 * Golden path Z1 - the invoice editor's customer defaults and tax mode (master plan wave 3, PR D).
 *
 * Pick a customer with 30-day terms and a 10% discount: Due date and the discount appear with nothing typed. Type 115
 * including VAT: the summary shows 100.00 + 15.00 and the draft stores unit_price 100. A zero-rated customer stores
 * tax_rate 0. Three units at R10 incl shows the difference from what was typed. A stored 1000 + 500 at 15% saves
 * unchanged through "Including VAT" and back. axe reports nothing serious in either theme on the new and edit pages, and
 * at 390 px the page does not scroll sideways.
 * Evidence mode: INVOICE_EVIDENCE_DIR=<dir> writes screenshots at 390 and 1568 in both themes.
 */
// golden:dev-only
// Dev only: it creates customers and draft invoices in a sandbox company and runs axe. The post-deploy run skips it by this marker.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { todayInSast } from '../../../src/lib/saDateParser';
import { addDaysISO } from '../../../src/lib/dateUtils';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NEW = '/accounting/customer-invoices/new';
const EDIT_KEY = '/accounting/customer-invoices/edit/[invoiceId]';
const EVIDENCE = process.env.INVOICE_EVIDENCE_DIR;
// Every save here goes to this sandbox company, never to Demo (Willie uses Demo for QA).
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a'; // y1's company: one sandbox for the invoice form
const TERMS = { name: '0GP-Golden-Terms-Customer', payment_terms: 30, payment_terms_type: 'days', default_discount: 10, default_vat_type: 'standard' };
const ZERO = { name: '0GP-Golden-Zero-Customer', payment_terms: 0, payment_terms_type: 'end_of_month', default_discount: 0, default_vat_type: 'zero' };
const PLAIN = { name: '0GP-Golden-Plain-Customer', payment_terms: 0, payment_terms_type: 'days', default_discount: 0, default_vat_type: 'standard' };

async function fixtureCustomer(api: Api, fields: typeof TERMS): Promise<void> {
  const found = await api.get<{ name: string }[]>(`/api/accounting/customers?q=${encodeURIComponent(fields.name)}`);
  if (!found.some((c) => c.name === fields.name)) await api.post('/api/accounting/customers', fields);
}

async function sandbox(context: BrowserContext, baseURL: string): Promise<Api> {
  const api = await Api.login(baseURL);
  const id = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, id);
  await switchBrowserCompany(context, id);
  await fixtureCustomer(api, TERMS);
  await fixtureCustomer(api, ZERO);
  await fixtureCustomer(api, PLAIN);
  return api;
}

async function open(page: Page): Promise<void> {
  await page.goto(NEW, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

async function pickClient(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Client' }).click();
  await page.getByPlaceholder(/search/i).last().fill(name);
  await page.locator('li[role=option]').filter({ hasText: name }).click();
  await expect(page.getByRole('combobox', { name: 'Client' })).toContainText(name);
}

async function pickMode(page: Page, mode: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Amounts are' }).click();
  await page.locator('li[role=option]').filter({ hasText: mode }).click();
}

async function saveDraft(page: Page): Promise<string> {
  await page.getByRole('button', { name: /^create invoice$/i }).click();
  await page.waitForURL(/\/accounting\/customer-invoices\/(?!new)[0-9a-f-]{36}/, { timeout: 30_000 });
  return /customer-invoices\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
const summary = (page: Page) => page.getByRole('heading', { name: 'Invoice Summary' }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
// The figure on a summary row alone: `15.00` anywhere in the card would also match 115.00.
const summaryFigure = (page: Page, label: string) => summary(page).locator('div.justify-between', { hasText: label }).locator('span').last();
const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
};

interface StoredInvoice { status: string; due_date: string; tax_rate: string | number; subtotal: string | number; total_amount: string | number; items: { unit_price: string | number; amount: string | number }[] }

test('a customer with terms and a discount fills the form; 115 incl stores unit_price 100', async ({ page, context, baseURL }) => {
  const api = await sandbox(context, baseURL!);
  await open(page);
  await pickClient(page, TERMS.name);

  const expectedDue = addDaysISO(todayInSast(), 30);
  await expect(page.getByLabel('Due date')).not.toHaveValue('');
  await expect(page.getByText('Customer terms: 30 days')).toBeVisible();
  await expect(page.getByLabel('Discount %')).toHaveValue('10');
  await expect(page.getByText('10% discount from customer')).toBeVisible();

  // The user's own figure wins over the default: with it cleared, 115 incl is exactly 100 + 15.
  await page.getByLabel('Discount %').fill('');
  await pickMode(page, 'Including VAT');
  await page.getByPlaceholder('Item description').fill(`Z1 incl ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('115');
  await expect(summaryFigure(page, 'Subtotal')).toHaveText(/^R\s?100\.00$/);
  await expect(summaryFigure(page, 'VAT (15%)')).toHaveText(/^R\s?15\.00$/);
  await expect(summaryFigure(page, 'Total')).toHaveText(/^R\s?115\.00$/);
  await expect(summary(page).getByText(/these prices come to/i)).toHaveCount(0);

  const id = await saveDraft(page);
  try {
    const inv = await api.get<StoredInvoice>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(inv.status).toBe('draft');
    expect(Number(inv.items[0]!.unit_price)).toBe(100);
    expect(Number(inv.tax_rate)).toBe(15);
    expect(Number(inv.total_amount)).toBe(115);
    expect(String(inv.due_date).slice(0, 10)).toBe(expectedDue);

    await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('', { timeout: 60_000 });
    await settle(page);
    await expect(page.getByLabel('Unit price')).toHaveValue('100'); // stored ex-VAT, shown exclusive
    await expect(page.getByRole('combobox', { name: 'Amounts are' })).toContainText('Excluding VAT');
  } finally {
    // One draft per run in the sandbox company: cancel it (a draft has no journal to reverse) so dev data does not grow unbounded.
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('a discount with inclusive prices reaches the stored row: 115 incl at 10% off is 100, 90 + 13.50', async ({ page, context, baseURL }) => {
  const api = await sandbox(context, baseURL!);
  await open(page);
  await pickClient(page, TERMS.name);
  await expect(page.getByLabel('Discount %')).toHaveValue('10');
  await pickMode(page, 'Including VAT');
  await page.getByPlaceholder('Item description').fill(`Z1 incl disc ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('115');
  await expect(summaryFigure(page, 'Total')).toHaveText(/^R\s?103\.50$/);
  const id = await saveDraft(page);
  try {
    const inv = await api.get<StoredInvoice>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(Number(inv.items[0]!.unit_price)).toBe(100);
    expect(Number(inv.items[0]!.amount)).toBe(90);
    expect(Number(inv.subtotal)).toBe(90);
    expect(Number(inv.total_amount)).toBe(103.5);
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('a stored 1000 + 500 at 15% saves unchanged after inclusive and back, and after saving while inclusive', async ({ page, context, baseURL }) => {
  const api = await sandbox(context, baseURL!);
  await open(page);
  await pickClient(page, PLAIN.name);
  await page.getByPlaceholder('Item description').fill(`Z1 stored ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('1000');
  await page.getByRole('button', { name: 'Add Line' }).click();
  await page.getByPlaceholder('Item description').nth(1).fill('Z1 stored two');
  await page.getByLabel('Unit price').nth(1).fill('500');
  const id = await saveDraft(page);

  const expectStored = async () => {
    const inv = await api.get<StoredInvoice>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(inv.items.map((i) => Number(i.unit_price)).sort((a, b) => b - a)).toEqual([1000, 500]);
    expect([Number(inv.subtotal), Number(inv.tax_rate), Number(inv.total_amount)]).toEqual([1500, 15, 1725]);
  };
  const edit = async () => {
    await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Unit price').first()).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await pickMode(page, 'Including VAT');
    await expect(page.getByLabel('Unit price incl. VAT').first()).toHaveValue('1150');
    await expect(summaryFigure(page, 'Total')).toHaveText(/^R\s?1[\s,]?725\.00$/);
    await expect(summary(page).getByText(/these prices come to/i)).toHaveCount(0);
  };
  const save = async () => {
    await page.getByRole('button', { name: /save changes/i }).click();
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
  };
  try {
    await expectStored();
    await edit();
    await pickMode(page, 'Excluding VAT');
    await expect(page.getByLabel('Unit price').first()).toHaveValue('1000');
    await save();
    await expectStored();

    await edit();
    await save();
    await expectStored();
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('a VAT choice that conflicts with the customer stands, and the form says so', async ({ page, context, baseURL }) => {
  await sandbox(context, baseURL!);
  await open(page);
  await pickMode(page, 'Excluding VAT');
  await pickClient(page, ZERO.name);
  await expect(page.getByText('This customer is zero-rated, but this invoice charges VAT at 15%.')).toBeVisible();
  await expect(page.getByLabel('VAT rate %')).toHaveValue('15');
  await pickMode(page, 'No VAT');
  await expect(page.getByText(/but this invoice/)).toHaveCount(0);
});

test('a zero-rated customer selects No VAT and stores tax_rate 0', async ({ page, context, baseURL }) => {
  const api = await sandbox(context, baseURL!);
  await open(page);
  await pickClient(page, ZERO.name);
  await expect(page.getByText('From customer: zero-rated')).toBeVisible();
  await expect(page.getByLabel('VAT rate %')).toBeDisabled();
  await page.getByPlaceholder('Item description').fill(`Z1 zero ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('115');
  const id = await saveDraft(page);
  try {
    const inv = await api.get<StoredInvoice>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(Number(inv.tax_rate)).toBe(0);
    expect(Number(inv.total_amount)).toBe(115);
    expect(Number(inv.items[0]!.unit_price)).toBe(115);
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

for (const theme of THEMES) {
  test(`${theme}: new and edit at 1568 and 390 px, the typed-total difference on screen, axe clean, no sideways scroll`, async ({ page, context, baseURL }) => {
    await seedTheme(page, theme);
    const api = await sandbox(context, baseURL!);
    await page.setViewportSize({ width: 1568, height: 900 });
    await open(page);
    await pickClient(page, TERMS.name);
    await expect(page.getByText('Customer terms: 30 days')).toBeVisible();
    await page.getByPlaceholder('Item description').fill('Three at ten');
    await page.getByLabel('Unit price').fill('10');
    await expect(page.getByText('-10%')).toBeVisible();
    await expectNoSeriousA11yViolations(page, { key: NEW }); // the discount column and its line note, as the customer's default opens them
    await page.getByLabel('Discount %').fill('');
    await pickMode(page, 'Including VAT');
    await page.getByLabel('Quantity').fill('3');
    await page.getByLabel('Unit price').fill('10');
    await expect(summary(page).getByText(/these prices come to/i)).toContainText(/These prices come to .*30\.00 incl\. VAT; the invoice total is .*30\.02/);
    await shot(page, `invoice-defaults-1568-${theme}`);
    await expectNoSeriousA11yViolations(page, { key: NEW });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summary(page).getByText(/these prices come to/i)).toBeVisible();
    expect(await sideways(page), 'the page must not scroll sideways').toBeLessThanOrEqual(390);
    await shot(page, `invoice-defaults-390-${theme}`);

    await page.setViewportSize({ width: 1568, height: 900 });
    const id = await saveDraft(page);
    try {
      await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByLabel('Unit price')).toHaveValue('8.7', { timeout: 60_000 });
      await settle(page);
      await shot(page, `invoice-edit-1568-${theme}`);
      await expectNoSeriousA11yViolations(page, { key: EDIT_KEY });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await sideways(page), 'the edit page must not scroll sideways').toBeLessThanOrEqual(390);
      await shot(page, `invoice-edit-390-${theme}`);
    } finally {
      await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
    }
  });
}
