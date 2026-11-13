// golden:dev-only
/**
 * Golden path (z20): comments on an invoice, a bill and a bank line (master plan wave 5, M14). Sandbox company, dev only.
 *
 *  - Invoice drawer: a comment whose body is markup is shown as TEXT (no element is made from it), can be edited
 *    ("(edited)") and deleted (it leaves the thread, and the server's list agrees).
 *  - Bill page and bank line drawer: the panel is there and a comment posts and shows.
 *  - axe reports 0 critical and 0 serious with the panel open, in both themes; nothing scrolls sideways at 390.
 *  - Nothing is emailed: no mail route is called, and a mention needs a second member the sandbox does not have (the
 *    mention path is proved against real Postgres in tests/integration/record-comments.int.test.ts).
 *  - COMMENTS_EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes to its own sandbox company, never Demo. Its comments are deleted in the run.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Api, gpRef, today } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, seedTheme, settle } from '../helpers/themeSpec';

const SANDBOX_NAME = '0GP Golden Comments Sandbox';
const SANDBOX_ONBOARDING_ID = '3b8f6d52-91c4-4e07-b6a8-5d2c7e1f9a30';
const NOTHING_EXCUSED = { pages: {} };
const XSS = '<img src=x onerror="window.__z20=1"><b>bold?</b>';
const WIDTHS = [{ width: 1568, height: 1000 }, { width: 390, height: 844 }];
const evidenceDir = process.env.COMMENTS_EVIDENCE_DIR;

test.setTimeout(240_000);

const overflowX = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const snap = async (page: Page, slug: string): Promise<void> => { if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${slug}.png`) }); };

/** Posts `text` in the open panel and waits for it to show. */
async function post(page: Page, text: string): Promise<void> {
  await page.getByLabel('Add a comment').fill(text);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('comment-body').filter({ hasText: text.slice(0, 12) })).toBeVisible({ timeout: 30_000 });
}

async function sandbox(page: Page, context: Parameters<typeof switchBrowserCompany>[0], baseURL: string): Promise<Api> {
  const api = await Api.login(baseURL);
  const id = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, id);
  await switchBrowserCompany(context, id);
  return api;
}

async function cleanup(api: Api, recordType: string, recordId: string): Promise<void> {
  const read = await api.get<{ comments: { id: string }[] }>(`/api/accounting/record-comments?recordType=${recordType}&recordId=${recordId}`);
  for (const c of read.comments) await api.del(`/api/accounting/record-comments?id=${c.id}`);
}

for (const theme of THEMES) {
  for (const size of WIDTHS) {
    test(`invoice drawer comments at ${size.width} (${theme}): text not markup, edit, delete, axe clean`, async ({ page, context, baseURL }) => {
      await page.setViewportSize(size);
      await seedTheme(page, theme);
      const mail: string[] = [];
      page.on('request', (r) => { if (/email|mail/i.test(new URL(r.url()).pathname) && r.method() !== 'GET') mail.push(r.url()); });
      const api = await sandbox(page, context, baseURL!);
      const ref = gpRef('CMT');
      const created = await api.post<{ id?: string; invoiceId?: string }>('/api/accounting/customer-invoices-create', {
        clientId: await api.fixtureCustomer(), invoiceDate: today(), dueDate: today(), taxRate: 15, notes: ref,
        items: [{ description: ref, quantity: 1, unitPrice: 100 }],
      });
      const invoiceId = (created.id ?? created.invoiceId)!;
      const detail = await api.get<{ invoice_number: string }>(`/api/accounting/customer-invoices-detail?id=${invoiceId}`);
      try {
        await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
        await settle(page);
        const link = page.locator('tbody tr a', { hasText: detail.invoice_number }).first();
        await expect(link).toBeVisible({ timeout: 60_000 });
        await link.focus();
        await page.keyboard.press('Enter');
        const drawer = page.getByRole('dialog', { name: `Invoice ${detail.invoice_number}` });
        await expect(drawer.getByTestId('comments-panel')).toBeVisible();
        await expect(drawer.getByText('No comments yet.')).toBeVisible();

        await post(page, XSS);
        const body = drawer.getByTestId('comment-body').first();
        await expect(body).toHaveText(XSS);
        expect(await drawer.locator('[data-testid="comments-panel"] img, [data-testid="comments-panel"] b').count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { __z20?: number }).__z20)).toBeUndefined();

        await drawer.getByRole('button', { name: 'Edit', exact: true }).click();
        await drawer.getByLabel('Edit your comment').fill('Edited note');
        await drawer.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(drawer.getByTestId('comment-body').first()).toHaveText('Edited note');
        await expect(drawer.getByText('(edited)')).toBeVisible();

        await settle(page);
        await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
        if (size.width === 390) expect(await overflowX(page), 'no sideways scroll').toBeLessThanOrEqual(0);
        await drawer.getByTestId('comments-panel').scrollIntoViewIfNeeded();
        await snap(page, `invoice-drawer-comments-${theme}-${size.width}`);

        await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
        await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(drawer.getByText('No comments yet.')).toBeVisible();
        const after = await api.get<{ comments: unknown[] }>(`/api/accounting/record-comments?recordType=customer_invoice&recordId=${invoiceId}`);
        expect(after.comments).toEqual([]);
        expect(mail, 'no mail route is called').toEqual([]);
      } finally {
        await cleanup(api, 'customer_invoice', invoiceId);
      }
    });
  }

  test(`bill page and bank line drawer show the panel and take a comment (${theme})`, async ({ page, context, baseURL }) => {
    await seedTheme(page, theme);
    const api = await sandbox(page, context, baseURL!);
    const bill = await api.post<{ id: string }>('/api/accounting/supplier-invoices', {
      supplierId: await api.fixtureSupplier(), invoiceDate: today(), dueDate: today(), taxRate: 15,
      items: [{ description: gpRef('CMTB'), quantity: 1, unitPrice: 100 }],
    });
    const accounts = await api.get<{ id: string }[]>('/api/accounting/bank-accounts');
    expect(accounts.length, 'the sandbox has a bank account').toBeGreaterThan(0);
    const bankAccountId = accounts[0]!.id;
    const ref = gpRef('CMTL');
    await api.post('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
      statementDate: today(), bankFormat: 'fnb', applyBankRules: false,
      csvContent: ['Date,Description,Amount,Balance,Reference', `${today().replace(/-/g, '/')},${ref} comment line,-42.00,958.00,${ref}`].join('\n'),
    });
    const q = new URLSearchParams({ bank_account_id: bankAccountId, status: 'imported', search: ref });
    const lineId = (await api.get<{ transactions: { id: string }[] }>(`/api/accounting/bank-transactions?${q}`)).transactions[0]!.id;
    try {
      await page.goto(`/accounting/supplier-invoices/${bill.id}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('comments-panel')).toBeVisible({ timeout: 60_000 });
      await post(page, 'Bill note from z20');
      await settle(page);
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      await snap(page, `bill-comments-${theme}`);

      await page.goto(`/accounting/bank-transactions?account_id=${bankAccountId}`, { waitUntil: 'domcontentloaded' });
      const row = page.locator('[data-testid="bank-tx-table"] tbody tr', { hasText: ref });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole('button', { name: /^Details, / }).click();
      const drawer = page.getByRole('dialog', { name: 'Bank line' });
      await expect(drawer.getByTestId('comments-panel')).toBeVisible();
      await post(page, 'Line note from z20');
      await settle(page);
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      await snap(page, `bank-line-comments-${theme}`);
    } finally {
      await cleanup(api, 'supplier_invoice', bill.id);
      await cleanup(api, 'bank_transaction', lineId);
      await api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: [lineId] });
    }
  });
}
