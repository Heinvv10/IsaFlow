/**
 * Golden path Y1 - the customer invoice form on the kit (master plan wave 2, PR I).
 *
 * Keyboard only: pick the client in the ContactPicker, type "t" and "+30" into the date fields, save a draft; the API
 * then holds ISO dates. axe reports nothing serious in either theme; at 390 px the page does not scroll sideways and
 * the summary card stacks under the form instead of overlapping it.
 * Evidence mode: INVOICE_EVIDENCE_DIR=<dir> writes screenshots at 390 and 1568 in both themes.
 */
// golden:dev-only
// Dev only: it creates a company and a draft invoice and runs axe against dev data. The post-deploy run skips it by this marker.
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { todayInSast } from '../../../src/lib/saDateParser';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NEW = '/accounting/customer-invoices/new';
const EVIDENCE = process.env.INVOICE_EVIDENCE_DIR;
// The keyboard test saves a draft, so it runs in its own sandbox company and never writes to Demo (Willie uses Demo for QA).
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a';

// The routes Create touches: the create API, the saved invoice's page, and the two reads that page makes at once.
const NIL_ID = '00000000-0000-0000-0000-000000000000';
const WARM_PAGE = `/accounting/customer-invoices/${NIL_ID}`;
const WARM_APIS = [
  '/api/accounting/customer-invoices-create', // GET answers 405: enough to compile the route, creates nothing
  `/api/accounting/customer-invoices-detail?id=${NIL_ID}`,
  `/api/accounting/customer-invoices-adjacent?id=${NIL_ID}`,
];

/**
 * `next dev` compiles a route on its first request and then tells every open page to do a full reload (see
 * u-list-filter-dates.spec.ts). Create is the first request for the saved invoice's page, so on a fresh dev server
 * (every hosted chunk piece) the reload landed on /new while the push to the invoice was still in flight: the invoice
 * was created, the page reloaded onto an empty /new, and waitForURL timed out (5 reds on 13-14 Nov, always chunk 4).
 * Requesting those routes once before any page is open makes the compile happen with no page to reload.
 */
test.beforeAll(async () => {
  test.setTimeout(240_000); // four cold compiles: longer than the config's 90 s test timeout
  const { baseURL, storageState } = test.info().project.use;
  if (!storageState) throw new Error('y1 warm-up needs the golden session (use.storageState); refusing to warm up unauthenticated');
  const ctx = await pwRequest.newContext({ baseURL, storageState });
  try {
    // No redirects: a stale session would 302 to /login and must fail here, not be mistaken for a warm route.
    const page = await ctx.get(WARM_PAGE, { timeout: 120_000, maxRedirects: 0 });
    expect(page.status(), `warm-up ${WARM_PAGE} (a 3xx means the session is not valid)`).toBe(200);
    for (const path of WARM_APIS) {
      const res = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 });
      expect(res.status(), `warm-up ${path}: the route must answer, even with a refusal`).toBeLessThan(500);
    }
  } finally {
    await ctx.dispose();
  }
});

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
    const summary = await page.getByRole('heading', { name: 'Invoice Summary' }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]').boundingBox();
    const notes = await page.getByLabel('Notes').boundingBox();
    expect(summary && notes).toBeTruthy();
    expect(summary!.y, 'summary starts below the last form card').toBeGreaterThanOrEqual(notes!.y + notes!.height - 1);
    expect(summary!.x + summary!.width).toBeLessThanOrEqual(390);
    // The Line Items header wraps instead of pushing "Add Line" past the card (it stuck out ~5 px and clipped its label).
    const add = await page.getByRole('button', { name: 'Add Line' }).boundingBox();
    const lines = await page.getByRole('button', { name: 'Add Line' }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]').boundingBox();
    expect(add && lines).toBeTruthy();
    expect(add!.x + add!.width, 'Add Line stays inside the Line Items card').toBeLessThanOrEqual(lines!.x + lines!.width);
    expect(add!.x).toBeGreaterThanOrEqual(lines!.x);
    if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: join(EVIDENCE, `invoice-new-390-${theme}.png`), fullPage: true }); }
  });

  test(`1568 px (${theme}): the summary sits beside the form`, async ({ page }) => {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1568, height: 900 });
    await open(page);
    const summary = await page.getByRole('heading', { name: 'Invoice Summary' }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]').boundingBox();
    const notes = await page.getByLabel('Notes').boundingBox();
    expect(summary!.x, 'summary is to the right of the form').toBeGreaterThan(notes!.x + notes!.width - 1);
    if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: join(EVIDENCE, `invoice-new-1568-${theme}.png`), fullPage: true }); }
  });
}
