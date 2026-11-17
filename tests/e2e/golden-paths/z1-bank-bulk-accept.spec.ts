// golden:dev-only
/**
 * Golden path Z1 (WP6): bulk accept of high-confidence suggestions - preview, confirm, undo batch.
 *
 * Seeds three imported lines and a suggest-only rule over them, runs the categoriser so each carries a 0.95 suggestion,
 * then drives the page: the "Accept N high-confidence suggestions" button opens the preview (rows, totals), Confirm posts
 * the batch, the result says "Posted 3", Undo batch reverses exactly that batch and the lines are back to imported.
 *
 * Dev-only: it writes a rule and statement lines, and Confirm posts every high-confidence line of the account - so it
 * stands down (skips) when the account holds any suggestion that is not this run's. BANK_TX_EVIDENCE_DIR=<dir> saves a
 * screenshot of the preview.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Api, gpRef, today } from './_api';

test.setTimeout(180_000);

test('bulk accept: preview, confirm, undo batch', async ({ baseURL, page }) => {
  const api = await Api.login(baseURL!);
  const ref = gpRef('BULK');
  const d = today().replace(/-/g, '/');
  let bankAccountId = '';
  let ruleId = '';
  let ids: string[] = [];
  try {
    const banks = await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts');
    expect(banks.length, 'company must have a bank account').toBeGreaterThan(0);
    bankAccountId = banks[0]!.id;
    const expense = await api.get<Array<{ id: string; isSystemAccount?: boolean }>>('/api/accounting/chart-of-accounts?subtype=default_expense');
    const expenseId = expense.find((a) => a.isSystemAccount === true)?.id ?? expense[0]?.id;
    expect(expenseId, 'a default expense account').toBeTruthy();

    const before = await api.get<{ lines: unknown[]; scanTruncated: boolean }>(`/api/accounting/bank-bulk-accept?bankAccountId=${bankAccountId}`);
    test.skip(before.lines.length > 0, 'the account already holds high-confidence suggestions: a confirm would post them too');

    const csv = ['Date,Description,Amount,Balance,Reference',
      `${d},${ref} fuel one,-110.00,9890.00,${ref}-1`,
      `${d},${ref} fuel two,-220.00,9670.00,${ref}-2`,
      `${d},${ref} fuel three,-330.00,9340.00,${ref}-3`].join('\n');
    await api.post('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
      statementDate: today(), csvContent: csv, bankFormat: 'fnb', applyBankRules: false,
    });
    const found = await api.get<{ transactions: Array<{ id: string }> }>(
      `/api/accounting/bank-transactions?bankAccountId=${bankAccountId}&status=imported&search=${encodeURIComponent(ref)}`);
    ids = found.transactions.map((t) => t.id);
    expect(ids).toHaveLength(3);

    const rule = await api.post<{ id?: string; rule?: { id: string } }>('/api/accounting/bank-rules', {
      ruleName: `${ref} fuel`, matchField: 'description', matchType: 'contains', matchPattern: ref, glAccountId: expenseId, autoCreateEntry: false,
    });
    ruleId = rule.id ?? rule.rule?.id ?? '';
    await api.post('/api/accounting/smart-categorize', { transactionIds: ids });

    // The page: the button names the count, the preview lists the three lines and their totals.
    await page.setViewportSize({ width: 1568, height: 1000 });
    await page.goto(`/accounting/bank-transactions?account_id=${bankAccountId}`);
    const button = page.getByRole('button', { name: /^Accept 3\+? high-confidence suggestions$/ });
    await expect(button).toBeVisible({ timeout: 60_000 });
    await button.click();
    const dialog = page.getByRole('dialog', { name: /Accept 3 high-confidence suggestions/ });
    await expect(dialog).toBeVisible();
    for (const n of ['one', 'two', 'three']) await expect(dialog.getByText(`${ref} fuel ${n}`)).toBeVisible();
    await expect(dialog.getByTestId('bulk-totals')).toContainText(/Total out.*660/);
    if (process.env.BANK_TX_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.BANK_TX_EVIDENCE_DIR, 'bulk-accept-preview.png') });

    // Confirm posts the batch.
    await dialog.getByRole('button', { name: /Confirm and post 3/ }).click();
    await expect(dialog.getByTestId('bulk-result')).toContainText('Posted 3 lines');
    const posted = await api.get<{ transactions: Array<{ status: string }> }>(
      `/api/accounting/bank-transactions?bankAccountId=${bankAccountId}&search=${encodeURIComponent(ref)}`);
    expect(posted.transactions.map((t) => t.status)).toEqual(['allocated', 'allocated', 'allocated']);

    // Undo batch reverses exactly that batch: the lines are imported again.
    await dialog.getByRole('button', { name: 'Undo batch' }).click();
    await expect(dialog.getByText(/Batch undone: 3 lines reversed/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    const undone = await api.get<{ transactions: Array<{ status: string }> }>(
      `/api/accounting/bank-transactions?bankAccountId=${bankAccountId}&search=${encodeURIComponent(ref)}`);
    expect(undone.transactions.map((t) => t.status)).toEqual(['imported', 'imported', 'imported']);
  } finally {
    try {
      if (ids.length > 0) await api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: ids });
      if (ruleId) await api.post('/api/accounting/bank-rules-action', { action: 'delete', id: ruleId });
    } catch (cleanupErr) {
      test.info().annotations.push({ type: 'cleanup-failed', description: String(cleanupErr) });
    }
    await api.dispose();
  }
});
