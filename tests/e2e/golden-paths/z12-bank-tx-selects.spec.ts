// golden:dev-only
/**
 * Golden path Z12 (master plan wave 4, NS2): the bank transactions grid on kit Selects.
 *
 * 1. Sandbox only: an imported line is allocated with the keyboard alone (each cell is focused, then chosen by
 *    keys): an expense account from the Selection popover, VAT "Standard 15%" by type-ahead, and a CC1 from the
 *    searchable cost-centre cell; Accept by Space. The posted journal carries the VAT line and the CC1 on the
 *    expense line. The line is imported for the run, then reversed and deleted.
 * 2. The page has no native select, and axe reports 0 critical and 0 serious (nothing excused), in both themes.
 * 3. (wave 5, UXB) At 1568x900 a row is 41 px comfortable and 33 px compact, and the Selection popover of a customer
 *    row stays inside the viewport with its search box and an option reachable.
 *
 * Enter is never pressed on a focused row: with a choice made it accepts, which posts.
 * Dev-only: axe, a sandbox company, a write. BANK_SELECTS_EVIDENCE_DIR=<dir> saves a screenshot per theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Api, gpRef, today } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, seedTheme } from '../helpers/themeSpec';

const BANK = '/accounting/bank-transactions';
const ROWS = '[data-testid="bank-tx-table"] tbody tr';
const SANDBOX_NAME = '0GP Golden Bank Selects Sandbox';
const SANDBOX_ONBOARDING_ID = '2b7c4f0e-9a51-4d6e-8c3f-5e1d2a7b9c40';
const CC_CODE = 'GPZ12';
const NOTHING_EXCUSED = { pages: {} };
const evidenceDir = process.env.BANK_SELECTS_EVIDENCE_DIR;

test.setTimeout(300_000);

interface Account { id: string; accountCode?: string; account_code?: string; accountName?: string; account_name?: string;
  accountType?: string; account_type?: string; isActive?: boolean; is_active?: boolean; vatInputDenied?: boolean; isHeader?: boolean }
interface JournalLine { glAccountId?: string; gl_account_id?: string; debit: number | string; cc1Id?: string | null; cc1_id?: string | null }

const code = (a: Account) => a.accountCode ?? a.account_code ?? '';
const name = (a: Account) => a.accountName ?? a.account_name ?? '';

/** An ordinary expense account VAT can be claimed on (not entertainment, not a non-supply name). */
async function expenseAccount(api: Api): Promise<Account> {
  const data = await api.get<Account[] | { accounts: Account[] }>('/api/accounting/chart-of-accounts');
  const all = Array.isArray(data) ? data : data.accounts;
  const ok = all.filter((a) => (a.accountType ?? a.account_type) === 'expense' && (a.isActive ?? a.is_active) !== false
    && !a.vatInputDenied && !a.isHeader && /materials|stationery|telephone|printing|office|computer|repairs/i.test(name(a)));
  expect(ok.length, 'the sandbox chart has an ordinary expense account').toBeGreaterThan(0);
  return ok[0]!;
}

async function costCentre(api: Api): Promise<string> {
  const { items } = await api.get<{ items: { id: string; code: string }[] }>('/api/accounting/cost-centres?cc_type=cc1&active=true');
  const found = items.find((c) => c.code === CC_CODE);
  if (found) return found.id;
  const created = await api.post<{ id: string }>('/api/accounting/cost-centres', { code: CC_CODE, name: 'Golden Z12 cost centre', ccType: 'cc1' });
  return created.id;
}

async function nativeSelects(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('select').length);
}

test('allocate an imported line by keyboard: account, VAT and CC1 reach the posted journal (sandbox)', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const accounts = await api.get<{ id: string }[]>('/api/accounting/bank-accounts');
  expect(accounts.length, 'the sandbox has a bank account').toBeGreaterThan(0);
  const bankAccountId = accounts[0]!.id;
  const expense = await expenseAccount(api);
  const ccId = await costCentre(api);

  const ref = gpRef('NS2');
  await api.post('/api/accounting/bank-transactions-bulk-commit', {
    bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
    statementDate: today(), bankFormat: 'fnb', applyBankRules: false,
    csvContent: ['Date,Description,Amount,Balance,Reference', `${today().replace(/-/g, '/')},${ref} kit line,-115.00,885.00,${ref}`].join('\n'),
  });
  const find = async (status: string) => {
    const q = new URLSearchParams({ bank_account_id: bankAccountId, status, search: ref });
    return (await api.get<{ transactions: { id: string; matchedJournalEntryId?: string; postedVatCode?: string }[] }>(
      `/api/accounting/bank-transactions?${q}`)).transactions[0];
  };
  const id = (await find('imported'))?.id;
  expect(id, 'the import created the line').toBeTruthy();
  // A harmless call through the action route first: on a cold dev server (GitHub-hosted, 4 vCPUs) its first compile
  // would otherwise land inside the Accept below (the suspected cause of this spec's first CI failure, where the row
  // was still on screen 60 s after Accept).
  await api.post('/api/accounting/bank-transactions-action', { action: 'update_notes', bankTransactionId: id, notes: ref });

  try {
    await page.goto(`${BANK}?account_id=${bankAccountId}`, { waitUntil: 'domcontentloaded' });
    const row = page.locator(ROWS, { hasText: ref });
    await expect(row).toBeVisible({ timeout: 60_000 });
    if (!(await row.getByRole('combobox', { name: /^Cost centre 1, / }).count())) {
      await page.getByRole('button', { name: 'CC', exact: true }).focus();
      await page.keyboard.press('Space');
    }
    expect(await nativeSelects(page), 'no native select on the page').toBe(0);

    // Account: the Selection popover, searched by code, chosen with Space (Enter on a row-level button is the grid's).
    await row.getByRole('button', { name: /Choose account, / }).focus();
    await page.keyboard.press('Space');
    await expect(row.getByRole('textbox', { name: 'Search accounts' })).toBeFocused();
    await page.keyboard.type(code(expense));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(row.getByRole('button', { name: /Choose account, / })).toContainText(name(expense));

    // VAT: ArrowDown opens on the current value, type-ahead moves the active option, Enter chooses.
    const vat = row.getByRole('combobox', { name: /^VAT, / });
    await vat.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('st');
    await page.keyboard.press('Enter');
    await expect(vat).toHaveText('Standard 15%');

    // CC1: a letter seeds the search box, ArrowDown takes the first match, Enter chooses.
    const cc1 = row.getByRole('combobox', { name: /^Cost centre 1, / });
    await cc1.focus();
    await page.keyboard.type(CC_CODE);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(cc1).toContainText(CC_CODE);
    await expect(cc1).toBeFocused();

    // The allocate request is awaited and its refusal, if any, is the failure message: a row that merely stays
    // on screen says nothing about why.
    const allocated = page.waitForResponse((r) => r.url().includes('/api/accounting/bank-transactions-action') && r.request().method() === 'POST'
      && (r.request().postData() ?? '').includes('"allocate"'), { timeout: 90_000 });
    await row.getByRole('button', { name: /^Accept, / }).focus();
    await page.keyboard.press('Space');
    const res = await allocated;
    expect(res.status(), `allocate answered ${res.status()}: ${(await res.text()).slice(0, 500)}`).toBe(200);
    await expect(row).toHaveCount(0, { timeout: 60_000 });

    const posted = await find('allocated') ?? await find('reconciled');
    expect(posted?.id).toBe(id);
    expect(posted!.postedVatCode).toBe('standard');
    const journal = await api.get<{ status: string; lines: JournalLine[] }>(`/api/accounting/journal-entries-detail?id=${posted!.matchedJournalEntryId}`);
    expect(journal.status).toBe('posted');
    const debits = journal.lines.filter((l) => Number(l.debit) > 0);
    const expenseLine = debits.find((l) => (l.glAccountId ?? l.gl_account_id) === expense.id);
    expect(expenseLine, 'the expense line is posted').toBeTruthy();
    expect(Number(expenseLine!.debit)).toBeCloseTo(100, 2);
    expect(expenseLine!.cc1Id ?? expenseLine!.cc1_id, 'CC1 reached the journal').toBe(ccId);
    const vatLine = debits.find((l) => l !== expenseLine);
    expect(Number(vatLine?.debit), 'the input VAT line is posted').toBeCloseTo(15, 2);
  } finally {
    const now = await find('allocated') ?? await find('reconciled');
    if (now) await api.post('/api/accounting/bank-transactions-action', { action: 'reverse', bankTransactionId: id });
    await api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: [id] });
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`no native select, axe 0 critical / 0 serious with a kit cell open (sandbox, ${theme})`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 1568, height: 900 });
    await seedTheme(page, theme);
    const api = await Api.login(baseURL!);
    const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
    await switchApiCompany(api, sandboxId);
    await switchBrowserCompany(context, sandboxId);
    const bankAccountId = (await api.get<{ id: string }[]>('/api/accounting/bank-accounts'))[0]!.id;
    const ref = gpRef('NS2A');
    await api.post('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
      statementDate: today(), bankFormat: 'fnb', applyBankRules: false,
      csvContent: ['Date,Description,Amount,Balance,Reference', `${today().replace(/-/g, '/')},${ref} axe line,-10.00,990.00,${ref}`].join('\n'),
    });
    const q = new URLSearchParams({ bank_account_id: bankAccountId, status: 'imported', search: ref });
    const id = (await api.get<{ transactions: { id: string }[] }>(`/api/accounting/bank-transactions?${q}`)).transactions[0]?.id;
    expect(id, 'the import created the line').toBeTruthy();
    try {
      await page.goto(`${BANK}?account_id=${bankAccountId}`, { waitUntil: 'domcontentloaded' });
      const row = page.locator(ROWS, { hasText: ref });
      await expect(row).toBeVisible({ timeout: 60_000 });
      expect(await nativeSelects(page)).toBe(0);
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      await row.getByRole('combobox', { name: /^VAT, / }).click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await expectNoSeriousA11yViolations(page, { baseline: NOTHING_EXCUSED });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `bank-tx-kit-selects-${theme}.png`) });
      await page.keyboard.press('Escape');
      // UXB: the row is 41 px (py-1 cells, sm selects), and 33 px once the header toggle says compact (xs selects).
      const rowHeight = async () => (await row.boundingBox())!.height;
      expect(Math.abs((await rowHeight()) - 41), `comfortable row is ${await rowHeight()} px`).toBeLessThanOrEqual(1);
      await page.getByRole('button', { name: /^Compact/ }).first().click();
      await expect.poll(rowHeight).toBeLessThanOrEqual(34);
      expect(Math.abs((await rowHeight()) - 33), `compact row is ${await rowHeight()} px`).toBeLessThanOrEqual(1);
      await page.getByRole('button', { name: /^Comfortable/ }).first().click();
      await expect.poll(rowHeight).toBeGreaterThanOrEqual(40);
      // UXB: the customer picker is reachable at 1568x900: inside the viewport, search box and an option visible.
      await row.getByRole('combobox', { name: /^Allocation type, / }).click();
      await page.getByRole('option', { name: 'Customer', exact: true }).click();
      await row.getByRole('button', { name: /Choose customer, / }).click();
      const popover = row.locator('[data-bank-dropdown]');
      await expect(popover.getByRole('textbox', { name: 'Search customers' })).toBeVisible();
      const box = (await popover.boundingBox())!;
      expect(box.y, 'popover top is on screen').toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, 'popover bottom is on screen').toBeLessThanOrEqual(900);
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `bank-tx-customer-picker-${theme}.png`) });
      await row.getByRole('button', { name: /Choose customer, / }).click(); // closes it (a Customer row has no VAT cell: this goes last)
    } finally {
      await api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: [id] });
      await api.dispose();
    }
  });
}
