/**
 * Golden path Y1 - the customer invoice form on the kit (master plan wave 2, PR I).
 *
 * Keyboard only: pick the client in the ContactPicker, type "t" and "+30" into the date fields, save a draft; the API
 * then holds ISO dates. axe reports nothing serious in either theme; at 390 px the page does not scroll sideways, the
 * totals sit under the line items inside the viewport, and the action bar stays at the bottom of the viewport (the
 * line-level form replaced the right-hand summary card); at 1568 px the same.
 * Evidence mode: INVOICE_EVIDENCE_DIR=<dir> writes screenshots at 390 and 1568 in both themes.
 */
// golden:dev-only
// Dev only: it creates a company and a draft invoice and runs axe against dev data. The post-deploy run skips it by this marker.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { todayInSast } from '../../../src/lib/saDateParser';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { warmInvoiceRoutes } from './helpers/warmInvoiceRoutes';

const NEW = '/accounting/customer-invoices/new';
const EVIDENCE = process.env.INVOICE_EVIDENCE_DIR;
// The keyboard test saves a draft, so it runs in its own sandbox company and never writes to Demo (Willie uses Demo for QA).
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a';

// Fresh `next dev` compiles on first request and reloads open pages: see helpers/warmInvoiceRoutes.ts.
test.beforeAll(warmInvoiceRoutes);

const plusDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
};

async function open(page: Page): Promise<void> {
  await page.goto(NEW, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

/** The totals under the last line row and inside the viewport's width; the action bar's bottom on the viewport's, its buttons inside it. */
async function expectTotalsUnderLinesAndBarPinned(page: Page, width: number): Promise<void> {
  const totals = await page.getByRole('region', { name: 'Invoice totals' }).boundingBox();
  const lastLine = await page.getByPlaceholder('Item description').last().boundingBox();
  expect(totals && lastLine).toBeTruthy();
  expect(totals!.y, 'the totals start under the line items').toBeGreaterThanOrEqual(lastLine!.y + lastLine!.height - 1);
  expect(totals!.x + totals!.width).toBeLessThanOrEqual(width);
  const viewport = page.viewportSize()!;
  const bar = await page.getByRole('group', { name: 'Invoice actions' }).boundingBox();
  expect(bar, 'the action bar is on screen without scrolling').toBeTruthy();
  expect(Math.abs(bar!.y + bar!.height - viewport.height), 'the action bar sits on the bottom of the viewport').toBeLessThanOrEqual(1);
  for (const name of [/^create invoice$/i, /save & new/i, /approve & email/i]) {
    const b = await page.getByRole('button', { name }).boundingBox();
    expect(b!.x + b!.width, `${String(name)} stays inside the viewport`).toBeLessThanOrEqual(width);
    expect(b!.y).toBeGreaterThanOrEqual(bar!.y);
  }
}

for (const theme of THEMES) {
  test(`axe: no serious or critical violation on invoice new (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await open(page);
    await expectNoSeriousA11yViolations(page, { key: NEW });
  });
}

test('keyboard only: client, "t" and "+30", save a draft, the API holds ISO dates', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  await api.fixtureCustomer();
  await open(page);

  await page.getByRole('combobox', { name: 'Client' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('0GP-Golden');
  const option = page.getByRole('option', { name: '0GP-Golden-Customer' });
  await expect(option).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Client' })).toContainText('0GP-Golden-Customer');

  const invoiceDate = page.getByLabel(/^Invoice date/);
  await invoiceDate.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('t');
  await page.keyboard.press('Tab'); // Due date
  await page.keyboard.type('+30');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Due date')).not.toHaveValue('');

  await page.getByPlaceholder('Item description').fill(`Y1 keyboard ${Date.now().toString(36)}`);
  await page.getByLabel('Unit price').fill('100');
  // The create answer first: it names the invoice, so a page that never reaches it fails saying so, and the draft is still cancelled below.
  const created = page.waitForResponse((r) => r.url().includes('/api/accounting/customer-invoices-create') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^create invoice$/i }).click();
  const res = await created;
  expect(res.status(), 'Create must answer 201').toBe(201);
  const body = await res.json() as { data?: { id?: string }; id?: string };
  const id = (body.data ?? body).id!;
  expect(id, 'the create answer names the invoice').toMatch(/^[0-9a-f-]{36}$/);
  try {
    await page.waitForURL(new RegExp(`/accounting/customer-invoices/${id}$`), { timeout: 30_000 });
    const inv = await api.get<{ status: string; invoice_date: string; due_date: string }>(`/api/accounting/customer-invoices-detail?id=${id}`);
    expect(inv.status).toBe('draft');
    expect(String(inv.invoice_date).slice(0, 10)).toBe(todayInSast());
    expect(String(inv.due_date).slice(0, 10)).toBe(plusDays(todayInSast(), 30));
  } finally {
    // One draft per run in the sandbox company: cancel it (a draft has no journal to reverse) so dev data does not grow unbounded.
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

for (const theme of THEMES) {
  test(`390 px (${theme}): no sideways scroll; the summary stacks under the form`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(390);
    await expectTotalsUnderLinesAndBarPinned(page, 390);
    // The Line Items header wraps instead of pushing "Add Line" past the card (it stuck out ~5 px and clipped its label).
    const add = await page.getByRole('button', { name: 'Add Line' }).boundingBox();
    const lines = await page.getByRole('button', { name: 'Add Line' }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]').boundingBox();
    expect(add && lines).toBeTruthy();
    expect(add!.x + add!.width, 'Add Line stays inside the Line Items card').toBeLessThanOrEqual(lines!.x + lines!.width);
    expect(add!.x).toBeGreaterThanOrEqual(lines!.x);
    if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: join(EVIDENCE, `invoice-new-390-${theme}.png`), fullPage: true }); }
  });

  test(`1568 px (${theme}): the totals sit under the lines and the actions at the bottom of the viewport`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await open(page);
    await expectTotalsUnderLinesAndBarPinned(page, 1568);
    if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: join(EVIDENCE, `invoice-new-1568-${theme}.png`), fullPage: true }); }
  });
}
