/**
 * Golden path Z2 - invoice autosave and Approve & email (master plan wave 3, PR S).
 *
 * Edit a sandbox draft: loading the page sends no PUT; a change shows "Saved" and survives a reload. Approve & email
 * approves the draft and opens the email form with the customer's address; nothing is sent until Send, and Send is
 * answered HERE: /api/accounting/invoice-email is route-fulfilled and must be hit exactly once (dev's SMTP is live, and
 * the fixture customer's address is a .invalid one besides). Leaving with a change unsaved asks; refusing keeps the page
 * with no page error (no unhandled rejection). axe reports nothing serious on new and edit, both themes, and on the
 * open email form.
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

/** Answers /api/accounting/invoice-email here, before anything loads: the real route would send through dev's live SMTP. */
async function interceptEmail(page: Page): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route('**/api/accounting/invoice-email', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { sent: true } }) });
  });
  return sent;
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
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const asked: string[] = [];
    page.once('dialog', async (d) => { asked.push(d.message()); await d.dismiss(); });
    await page.getByPlaceholder('Item description').first().fill(changed);
    await page.getByRole('link', { name: 'Cancel' }).click(); // before the 1.5 s autosave: the change is unsaved
    await expect.poll(() => asked).toEqual(['This invoice has changes that are not saved yet. Leave without them?']);
    expect(page.url()).toContain(`/edit/${id}`);
    await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible({ timeout: 15_000 });
    expect(errors, 'a refused leave is not a page error').toEqual([]);
    await expect(page.getByText(/Navigation cancelled|Unhandled Runtime Error/)).toHaveCount(0); // no Next error overlay (dev)
    expect(puts()).toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Item description').first()).toHaveValue(changed, { timeout: 60_000 });
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('Back from the edit page with a change still unsaved: not refused, history intact, the change saved as the page goes', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const id = await draft(api, customerId, `Z2 back ${Date.now().toString(36)}`);
  try {
    await page.goto(`/accounting/customer-invoices/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /^edit$/i })).toBeVisible({ timeout: 60_000 });
    await settle(page); // hydrated: the Edit link navigates client-side, so Back is a popstate, not a page load
    await page.getByRole('link', { name: /^edit$/i }).click();
    await page.waitForURL(new RegExp(`/edit/${id}$`), { timeout: 60_000 });
    await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
    let asked = 0;
    page.on('dialog', async (d) => { asked++; await d.dismiss(); });
    const changed = `Z2 kept on Back ${Date.now().toString(36)}`;
    await page.getByPlaceholder('Item description').first().fill(changed);
    await page.goBack(); // inside the 1.5 s autosave wait
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
    expect(asked, 'Back is not refused').toBe(0);
    await expect.poll(async () => (await api.get<{ items: { description: string }[] }>(`/api/accounting/customer-invoices-detail?id=${id}`)).items[0]!.description,
      { timeout: 15_000 }).toBe(changed);
    await page.goForward(); // the edit page's entry is still there
    await page.waitForURL(new RegExp(`/edit/${id}$`), { timeout: 30_000 });
    await page.goBack();
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('Approve & email approves, opens the email form, and sends only on Send (route-fulfilled, hit once)', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const sent = await interceptEmail(page);
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
    await expect(page.getByRole('dialog', { name: 'Email Invoice' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, { key: EDIT_KEY });

    await page.getByRole('button', { name: /send email/i }).click();
    await expect(page.getByText('Invoice emailed successfully!')).toBeVisible();
    expect(sent).toEqual([{ invoiceId: id, recipientEmail: CUSTOMER.email }]);

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
    expect(sent, 'the email route was hit exactly once').toHaveLength(1);
  } finally {
    // An approved invoice's cancel reverses its journal: the sandbox keeps no open AR from this run.
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

test('on a new invoice, once approved the form behind the email form is inert: Enter on Create makes no second invoice', async ({ page, context, baseURL }) => {
  const { api } = await sandbox(context, baseURL!);
  const sent = await interceptEmail(page);
  let creates = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/accounting/customer-invoices-create')) creates++; });
  await page.goto(NEW, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await page.getByRole('combobox', { name: 'Client' }).click();
  await page.getByPlaceholder(/search/i).last().fill(CUSTOMER.name);
  await page.locator('li[role=option]').filter({ hasText: CUSTOMER.name }).click();
  await page.getByPlaceholder('Item description').fill(`Z2 new approve ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('100');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/accounting/customer-invoices-create'));
  await page.getByRole('button', { name: /approve & email/i }).click();
  const id = ((await (await created).json()) as { data: { id: string } }).data.id;
  try {
    await expect(page.getByRole('dialog', { name: 'Email Invoice' })).toBeVisible({ timeout: 30_000 });
    const create = page.getByRole('button', { name: /^create invoice$/i });
    await expect(create).toBeDisabled();
    await expect(page.getByPlaceholder('Item description')).toBeDisabled();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2_000);
    expect(creates, 'one invoice, however Enter is pressed').toBe(1);
    expect(sent, 'nothing sent').toEqual([]);
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

for (const theme of THEMES) {
  test(`${theme}: new and edit with the autosave line on, and the open email form, axe clean`, async ({ page, context, baseURL }) => {
    await seedTheme(page, theme);
    const { api, customerId } = await sandbox(context, baseURL!);
    const sent = await interceptEmail(page);
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
      await page.getByRole('button', { name: /approve & email/i }).click();
      await expect(page.getByRole('dialog', { name: 'Email Invoice' })).toBeVisible({ timeout: 30_000 });
      await shot(page, `invoice-email-dialog-${theme}`);
      await expectNoSeriousA11yViolations(page, { key: EDIT_KEY });
      await page.keyboard.press('Escape');
      await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
      expect(sent, 'nothing sent').toEqual([]);
    } finally {
      await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
    }
  });
}
