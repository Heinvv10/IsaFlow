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
import { expect, test, type Page } from '@playwright/test';
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
  await page.getByRole('button', { name: /^create invoice$/i }).click();
  await page.waitForURL(/\/accounting\/customer-invoices\/(?!new)[0-9a-f-]{36}/, { timeout: 30_000 });

  const id = /customer-invoices\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  try {
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
