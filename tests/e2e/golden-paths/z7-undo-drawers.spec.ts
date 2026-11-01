// golden:dev-only
/**
 * Golden path Z7 (master plan U): undo toasts and drawers.
 *
 * 1. Sandbox only: exclude an imported line, Undo from the toast, and the line is back on the New tab and `imported`.
 *    The line is imported for the run and deleted after it. Allocate's Undo is not driven here: it posts and reverses
 *    a journal, which tests/integration/u-undo-bank-allocate.int.test.ts proves against a real ledger.
 * 2. Read-only, Demo: an invoice drawer and a bank line drawer at 1568 and 390, both themes. Axe reports 0 critical and
 *    0 serious with the drawer open, the drawer fits the viewport, and focus comes back to what opened it.
 *
 * Dev-only: axe, a sandbox company, a write, dev data. UNDO_EVIDENCE_DIR=<dir> saves a screenshot per width and theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Api, gpRef, today } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, seedTheme, settle } from '../helpers/themeSpec';

const BANK = '/accounting/bank-transactions';
const INVOICES = '/accounting/customer-invoices';
const ROWS = '[data-testid="bank-tx-table"] tbody tr';
const SANDBOX_NAME = '0GP Golden Undo Sandbox';
const SANDBOX_ONBOARDING_ID = '5f0f1f3e-7c55-4b3a-9f43-0d3a6a1f7e27';
const NOTHING_EXCUSED = { pages: {} };
const WIDTHS = [{ width: 1568, height: 1000 }, { width: 390, height: 844 }];
const evidenceDir = process.env.UNDO_EVIDENCE_DIR;

test.setTimeout(240_000);

async function expectDrawerFits(page: Page, width: number): Promise<void> {
  const box = await page.getByRole('button', { name: 'Close drawer' }).locator('../..').boundingBox();
  expect(box, 'the panel is on screen').not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(Math.min(width, 480));
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

for (const theme of THEMES) test(`exclude an imported line, Undo, and it is back (sandbox, ${theme})`, async ({ page, context, baseURL }) => {
  await seedTheme(page, theme);
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const accounts = await api.get<{ id: string }[]>('/api/accounting/bank-accounts');
  expect(accounts.length, 'the sandbox has a bank account').toBeGreaterThan(0);
  const bankAccountId = accounts[0]!.id;

  const ref = gpRef('UNDO');
  await api.post('/api/accounting/bank-transactions-bulk-commit', {
    bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
    statementDate: today(), bankFormat: 'fnb', applyBankRules: false,
    csvContent: ['Date,Description,Amount,Balance,Reference', `${today().replace(/-/g, '/')},${ref} undo line,-42.00,958.00,${ref}`].join('\n'),
  });
  const lineId = async (status: string): Promise<string | undefined> => {
    const q = new URLSearchParams({ bank_account_id: bankAccountId, status, search: ref });
    const page1 = await api.get<{ transactions: { id: string; description?: string }[] }>(`/api/accounting/bank-transactions?${q}`);
    return page1.transactions[0]?.id;
  };
  const id = await lineId('imported');
  expect(id, 'the import created the line').toBeTruthy();

  try {
    await page.goto(`${BANK}?account_id=${bankAccountId}`, { waitUntil: 'domcontentloaded' });
    const row = page.locator(ROWS, { hasText: ref });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole('button', { name: /^Exclude, / }).click();
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await page.getByRole('button', { name: 'Exclude Transaction' }).click();

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await expect(row).toHaveCount(0);
    expect(await lineId('excluded')).toBe(id);

    // Past the 8 s while focused: the toast has to be waiting for the keyboard, and it is on the theme's tokens.
    await undo.focus();
    await page.waitForTimeout(9_000);
    await expect(undo).toBeFocused();
    await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `undo-toast-${theme}.png`) });
    await page.keyboard.press('Enter');

    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Transaction restored')).toBeVisible();
    expect(await lineId('imported')).toBe(id);
    expect(await lineId('excluded')).toBeUndefined();
  } finally {
    await api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: [id] });
  }
});

for (const theme of THEMES) {
  for (const size of WIDTHS) {
    test(`invoice drawer at ${size.width} (${theme}): opens from a row, fits, axe clean, focus returns`, async ({ page }) => {
      await page.setViewportSize(size);
      await seedTheme(page, theme);
      await page.goto(INVOICES, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const number = page.locator('tbody tr a').first();
      await expect(number, 'Demo has invoices').toBeVisible();
      const name = (await number.textContent())!;
      await number.focus();
      await page.keyboard.press('Enter');

      const drawer = page.getByRole('dialog', { name: `Invoice ${name}` });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId('invoice-drawer-outstanding')).toBeVisible();
      expect(page.url(), 'a plain click stays on the list').toContain(INVOICES);
      expect(page.url()).not.toMatch(/customer-invoices\/[0-9a-f-]{36}/);
      await expectDrawerFits(page, size.width);
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `invoice-drawer-${theme}-${size.width}.png`) });

      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(number).toBeFocused();
    });

    test(`bank line drawer at ${size.width} (${theme}): opens from a row, fits, axe clean, focus returns`, async ({ page }) => {
      await page.setViewportSize(size);
      await seedTheme(page, theme);
      await page.goto(BANK, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const details = page.locator(ROWS).first().getByRole('button', { name: /^Details, / });
      await expect(details, 'Demo has bank lines').toBeVisible();
      await details.click();

      const drawer = page.getByRole('dialog', { name: 'Bank line' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('heading', { name: 'Matched journal' })).toBeVisible();
      await expectDrawerFits(page, size.width);
      await settle(page);
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `bank-drawer-${theme}-${size.width}.png`) });

      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(details).toBeFocused();
    });
  }
}
