/**
 * Golden path Z2 - invoice autosave and Approve & email (master plan wave 3, PR S).
 *
 * Edit a sandbox draft: loading the page sends no PUT; a change shows "Saved" and survives a reload. Approve & email
 * approves the draft and opens the email form with the customer's address; nothing is sent until Send, and Send is
 * answered HERE: /api/accounting/invoice-email is route-fulfilled and must be hit exactly once (dev's SMTP is live, and
 * the fixture customer's address is a .invalid one besides). axe reports nothing serious on new and edit, both themes.
 * Evidence mode: INVOICE_EVIDENCE_DIR=<dir> writes screenshots.
 */
// golden:dev-only
// Dev only: it writes and approves invoices in a sandbox company, intercepts the email route and runs axe. The post-deploy run skips it by this marker.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { todayInSast } from '../../../src/lib/saDateParser';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NEW = '/accounting/customer-invoices/new';
const EDIT_KEY = '/accounting/customer-invoices/edit/[invoiceId]';
const EVIDENCE = process.env.INVOICE_EVIDENCE_DIR;
// Every write here goes to this sandbox company, never to Demo (Willie uses Demo for QA).
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a'; // y1's and z1's company: one sandbox for the invoice form
const CUSTOMER = { name: '0GP-Golden-Autosave-Customer', email: 'golden-z2@example.invalid', payment_terms: 0, payment_terms_type: 'days', default_discount: 0, default_vat_type: 'standard' };

async function sandbox(context: BrowserContext, baseURL: string): Promise<{ api: Api; customerId: string }> {
  const api = await Api.login(baseURL);
  const id = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, id);
  await switchBrowserCompany(context, id);
  const found = await api.get<{ id: string; name: string }[]>(`/api/accounting/customers?q=${encodeURIComponent(CUSTOMER.name)}`);
  const existing = found.find((c) => c.name === CUSTOMER.name);
  const customerId = existing?.id ?? (await api.post<{ id: string }>('/api/accounting/customers', CUSTOMER)).id;
  return { api, customerId };
}

async function draft(api: Api, customerId: string, description: string): Promise<string> {
  const made = await api.post<{ id: string }>('/api/accounting/customer-invoices-create', {
    clientId: customerId, invoiceDate: todayInSast(), taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1,
    items: [{ description, quantity: 1, unitPrice: 100 }],
  });
  return made.id;
}

async function openEdit(page: Page, id: string): Promise<void> {
  await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
  await settle(page);
}

/** Every draft PUT the page sends from now on. */
function countPuts(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/accounting/customer-invoices-detail')) n++; });
  return () => n;
}

const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
};

test('editing a draft autosaves after a change, never on load, and the change survives a reload', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const id = await draft(api, customerId, `Z2 autosave ${Date.now().toString(36)}`);
  try {
    const puts = countPuts(page);
    await openEdit(page, id);
    await page.waitForTimeout(3_000);
    expect(puts(), 'loading the edit page must send no PUT').toBe(0);

    const changed = `Z2 changed ${Date.now().toString(36)}`;
    await page.getByPlaceholder('Item description').first().fill(changed);
    await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible({ timeout: 15_000 });
    expect(puts()).toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Item description').first()).toHaveValue(changed, { timeout: 60_000 });
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('Approve & email approves, opens the email form, and sends only on Send (route-fulfilled, hit once)', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const sent: unknown[] = [];
  // Before anything loads: the real route would email the customer through dev's live SMTP.
  await page.route('**/api/accounting/invoice-email', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { sent: true } }) });
  });
  const id = await draft(api, customerId, `Z2 approve ${Date.now().toString(36)}`);
  try {
    await openEdit(page, id);
    await page.getByRole('button', { name: /approve & email/i }).click();
    await expect(page.getByRole('heading', { name: 'Email Invoice' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder('client@example.com')).toHaveValue(CUSTOMER.email);
    await expect(page.getByText('Approved. Nothing is sent until you click Send Email.')).toBeVisible();
    expect((await api.get<{ status: string }>(`/api/accounting/customer-invoices-detail?id=${id}`)).status).toBe('approved');
    expect(sent, 'nothing is sent before Send').toEqual([]);
    await shot(page, 'invoice-approve-email-modal');

    await page.getByRole('button', { name: /send email/i }).click();
    await expect(page.getByText('Invoice emailed successfully!')).toBeVisible();
    expect(sent).toEqual([{ invoiceId: id, recipientEmail: CUSTOMER.email }]);

    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
    expect(sent, 'the email route was hit exactly once').toHaveLength(1);
  } finally {
    // An approved invoice's cancel reverses its journal: the sandbox keeps no open AR from this run.
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

for (const theme of THEMES) {
  test(`${theme}: new and edit with the autosave line on, axe clean`, async ({ page, context, baseURL }) => {
    await seedTheme(page, theme);
    const { api, customerId } = await sandbox(context, baseURL!);
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(NEW, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await page.getByPlaceholder('Item description').fill('Z2 kept on this device');
    await expect(page.getByText(/^Saved on this device/)).toBeVisible({ timeout: 10_000 });
    await shot(page, `invoice-new-autosave-${theme}`);
    await expectNoSeriousA11yViolations(page, { key: NEW });

    const id = await draft(api, customerId, `Z2 axe ${Date.now().toString(36)}`);
    try {
      await openEdit(page, id);
      await page.getByPlaceholder('Item description').first().fill(`Z2 axe edited ${theme}`);
      await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible({ timeout: 15_000 });
      await shot(page, `invoice-edit-autosave-${theme}`);
      await expectNoSeriousA11yViolations(page, { key: EDIT_KEY });
    } finally {
      await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
    }
  });
}
