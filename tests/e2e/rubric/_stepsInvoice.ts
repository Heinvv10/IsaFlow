/**
 * Rubric steps on customer invoices (master plan wave 4, MW): M4 server autosave, and T2 new invoice to the open
 * Approve & email form (with PV's unsaved preview once it exists, and NS1's native-select count). Sandbox only.
 */
import { expect, type Page } from '@playwright/test';
import type { Api } from '../golden-paths/_api';
import { countPuts } from '../golden-paths/_invoiceAutosaveFixture';
import { notBuilt, Tally, type Evidence, type StepRecord } from './_rubricEvidence';
import type { Seeded } from './_rubricSeed';
import { loadedOrReload, routeMissing, waitForPost } from './_rubricUi';

const NEW = '/accounting/customer-invoices/new';
const CREATE = '/api/accounting/customer-invoices-create';

/** Opens the draft's edit page and waits for its description (one reload allowed, see loadedOrReload). */
async function openDraft(page: Page, id: string): Promise<number> {
  await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
  const reloads = await loadedOrReload(page, page.getByPlaceholder('Item description').first());
  await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
  return reloads; // the description is filled from the API, so the page has hydrated
}

/** M4: one edit to the draft's description saves once on its own, and survives a reload. */
export async function measureM4(page: Page, ev: Evidence, seed: Seeded): Promise<StepRecord> {
  const puts = countPuts(page);
  const reloadsToOpen = await openDraft(page, seed.draftInvoiceId);
  const loadPuts = puts();
  const text = `Rubric M4 ${Date.now().toString(36)}`;
  const t0 = Date.now();
  await page.getByPlaceholder('Item description').first().fill(text);
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible({ timeout: 30_000 });
  const msToSaved = Date.now() - t0;
  await page.waitForTimeout(2_000); // a second PUT would have left by now
  const editPuts = puts() - loadPuts;
  const screenshot = await ev.shot(page, 'm4-saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByPlaceholder('Item description').first()).toHaveValue(text, { timeout: 60_000 });
  return {
    status: 'measured', reloadsToOpen, msToSaved, note: 'includes the autosave debounce', putsOnLoad: loadPuts, putsForOneEdit: editPuts,
    exactlyOnePut: editPuts === 1, survivesReload: true, screenshot,
  };
}

/** PV: the unsaved invoice's PDF preview, once the route exists. */
async function preview(page: Page, api: Api, tally: Tally): Promise<StepRecord> {
  if (await routeMissing(api, '/api/accounting/invoice-pdf-preview')) {
    return notBuilt('PV (invoice preview before the first save) has not merged: /api/accounting/invoice-pdf-preview does not exist');
  }
  const t0 = Date.now();
  await tally.click(page.getByRole('button', { name: /preview/i }).first());
  await expect(page.locator('iframe').first()).toBeVisible({ timeout: 60_000 });
  const ms = Date.now() - t0;
  const close = page.getByRole('button', { name: /^close/i }).first();
  if (await close.isVisible()) await tally.click(close);
  return { status: 'measured', msToPreview: ms };
}

/**
 * T2: two lines, one discounted, Approve & email up to the open email form, then Send, which the context's intercept
 * answers. Records clicks, fields and time to the open form. The invoice is cancelled afterwards.
 */
export async function measureT2(page: Page, ev: Evidence, api: Api, seed: Seeded): Promise<StepRecord> {
  await page.goto(NEW, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  const nativeSelects = await page.locator('select').count();
  const tally = new Tally(page);

  await tally.click(page.getByRole('combobox', { name: 'Client' }));
  await tally.fill(page.getByPlaceholder(/search/i).last(), seed.customer.name);
  await tally.click(page.locator('li[role=option]').filter({ hasText: seed.customer.name }));
  await tally.fill(page.getByPlaceholder('Item description').first(), 'Rubric T2 consulting');
  await tally.fill(page.getByLabel('Unit price').first(), '1000');
  await tally.click(page.getByRole('button', { name: /add line/i }));
  await tally.fill(page.getByPlaceholder('Item description').nth(1), 'Rubric T2 discounted');
  await tally.fill(page.getByLabel('Unit price').nth(1), '500');
  await tally.click(page.getByRole('button', { name: /disc\. %/i }));
  await tally.fill(page.getByLabel('Discount %').nth(1), '10');
  const pv = await preview(page, api, tally);

  const created = waitForPost(page, CREATE);
  await tally.click(page.getByRole('button', { name: /approve & email/i }));
  const id = ((await (await created).json()) as { data: { id: string } }).data.id;
  try {
    await expect(page.getByRole('dialog', { name: 'Email Invoice' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder('client@example.com')).toHaveValue(seed.customer.email);
    const toOpenForm = tally.summary();
    const screenshot = await ev.shot(page, 't2-email-form');
    await tally.click(page.getByRole('button', { name: /send email/i }));
    await expect(page.getByText('Invoice emailed successfully!')).toBeVisible({ timeout: 30_000 });
    const stored = await api.get<{ status: string; items: unknown[] }>(`/api/accounting/customer-invoices-detail?id=${id}`);
    return {
      status: 'measured', toOpenEmailForm: toOpenForm, includingSend: tally.summary(), lines: stored.items.length,
      invoiceStatus: stored.status, customerEmailPrefilled: true, sendIntercepted: true,
      xero: 'reference click count is supplied by the re-score', preview: pv,
      ns1NativeSelectsOnNewInvoice: nativeSelects, screenshot,
    };
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
}
