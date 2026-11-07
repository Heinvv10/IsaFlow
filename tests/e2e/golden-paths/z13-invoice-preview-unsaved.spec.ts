/**
 * Golden path Z13 - the invoice PDF preview before the first save (master plan wave 4, PR PV).
 *
 * On a new invoice, type two lines and open "Preview PDF": the PDF comes from invoice-pdf-preview, prints the total the
 * summary shows and "PREVIEW: NOT SAVED", and no invoice is created (create is never called, and the customer's invoice
 * list stays as it was). axe reports nothing serious with the preview open, in both themes; at 390 px the page does not
 * scroll sideways.
 * Evidence mode: INVOICE_EVIDENCE_DIR=<dir> writes screenshots at 390 and 1568 in both themes and the preview PDF (a
 * headless browser frames a PDF blank, so the PDF itself is the evidence of what the frame shows).
 */
// golden:dev-only
// Dev only: it creates a customer in a sandbox company and runs axe. The post-deploy run skips it by this marker.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NEW = '/accounting/customer-invoices/new';
const EVIDENCE = process.env.INVOICE_EVIDENCE_DIR;
// Writes go to the invoice-form sandbox (y1's and z1's company), never to Demo.
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a';
const CUSTOMER = { name: '0GP-Golden-Preview-Customer', payment_terms: 30, payment_terms_type: 'invoice_days', default_discount: 0, default_vat_type: 'standard' };

async function sandbox(context: BrowserContext, baseURL: string): Promise<{ api: Api; customerId: string }> {
  const api = await Api.login(baseURL);
  const id = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, id);
  await switchBrowserCompany(context, id);
  const found = await api.get<{ id: string; name: string }[]>(`/api/accounting/customers?q=${encodeURIComponent(CUSTOMER.name)}`);
  const existing = found.find((c) => c.name === CUSTOMER.name);
  if (existing) return { api, customerId: existing.id };
  const made = await api.post<{ id: string }>('/api/accounting/customers', CUSTOMER);
  return { api, customerId: made.id };
}

/** Nothing here may create or send: both routes fail the run if they are called. */
async function guardWrites(page: Page): Promise<string[]> {
  const hits: string[] = [];
  for (const path of ['**/api/accounting/customer-invoices-create', '**/api/accounting/invoice-email']) {
    await page.route(path, async (route) => { hits.push(route.request().url()); await route.abort(); });
  }
  return hits;
}

async function fillTwoLines(page: Page): Promise<void> {
  await page.goto(NEW, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await page.getByRole('combobox', { name: 'Client' }).click();
  await page.getByPlaceholder(/search/i).last().fill(CUSTOMER.name);
  await page.locator('li[role=option]').filter({ hasText: CUSTOMER.name }).click();
  await expect(page.getByRole('combobox', { name: 'Client' })).toContainText(CUSTOMER.name);
  await page.getByPlaceholder('Item description').first().fill('Z13 consulting');
  await page.getByLabel('Quantity').first().fill('3');
  await page.getByLabel('Unit price').first().fill('250');
  await page.getByRole('button', { name: /add line/i }).click();
  await page.getByPlaceholder('Item description').nth(1).fill('Z13 travel');
  await page.getByLabel('Unit price').nth(1).fill('99.99');
}

/** Opens the preview and returns the PDF's text, read from the response the frame shows. */
async function openPreview(page: Page, theme: string): Promise<string> {
  const answered = page.waitForResponse((r) => r.url().includes('/api/accounting/invoice-pdf-preview') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  await expect(page.getByTitle('Invoice PDF preview')).toBeVisible({ timeout: 30_000 });
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  const pdf = await res.body();
  if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); writeFileSync(join(EVIDENCE, `invoice-preview-unsaved-${theme}.pdf`), pdf); }
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
};

for (const theme of THEMES) {
  test(`${theme}: the preview of an unsaved invoice shows the typed total and creates nothing`, async ({ page, context, baseURL }) => {
    const { api, customerId } = await sandbox(context, baseURL!);
    const before = await api.get<{ total: number }>(`/api/accounting/customer-invoices-list?client_id=${customerId}`);
    const hits = await guardWrites(page);
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await fillTwoLines(page);
    // 3 × 250 + 99.99 = 849.99; VAT 127.50; total 977.49.
    await expect(page.getByText(/R\s?977\.49/).first()).toBeVisible();

    const text = await openPreview(page, theme);
    expect(text).toContain('PREVIEW: NOT SAVED');
    expect(text).toMatch(/R 977\.49/);
    expect(text).toContain('Z13 travel');
    await page.getByRole('button', { name: 'Preview PDF' }).scrollIntoViewIfNeeded();
    await shot(page, `invoice-preview-unsaved-${theme}-1568`);
    await expectNoSeriousA11yViolations(page, { key: NEW });

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, `invoice-preview-unsaved-${theme}-390`);

    expect(hits).toEqual([]);
    const after = await api.get<{ total: number }>(`/api/accounting/customer-invoices-list?client_id=${customerId}`);
    expect(after.total).toBe(before.total);
  });
}
