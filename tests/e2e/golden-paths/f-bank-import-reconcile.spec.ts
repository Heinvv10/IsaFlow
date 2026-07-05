/**
 * Golden path (f): bank statement import (CSV + MT940) → rule match →
 * transactions land in the recon queue.
 *
 * Known-good at baseline for dev Demo (has bank accounts + 24 rules); the
 * July-4 audit could not test banking on prod Demo (0 bank accounts — P2.3
 * seeds them). Pins the import machinery end-to-end over HTTP.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';
import { randomUUID } from 'crypto';

test('bank import: CSV and MT940 statements create transactions and rules can match', async ({
  baseURL,
}) => {
  const api = await Api.login(baseURL!);
  const importedTxnIds: string[] = [];
  try {
    const accounts = await api.get<any[]>('/api/accounting/bank-accounts');
    expect(accounts.length, 'company must have a bank account (prod Demo gap = P2.3)').toBeGreaterThan(0);
    const bankAccountId = accounts[0].id;

    const ref = gpRef('BNK');
    const d = today().replace(/-/g, '/'); // FNB CSV uses YYYY/MM/DD

    // ── CSV import (FNB format: Date, Description, Amount, Balance, Reference)
    const csvContent = [
      'Date,Description,Amount,Balance,Reference',
      `${d},${ref} coffee supplies,-150.00,9850.00,${ref}-1`,
      `${d},${ref} client deposit,2500.00,12350.00,${ref}-2`,
    ].join('\n');

    const preview = await api.post<any>('/api/accounting/bank-transactions-bulk-preview', {
      bankAccountId,
      fileType: 'csv',
      filename: `${ref}.csv`,
      csvContent,
      bankFormat: 'fnb',
    });
    const previewText = JSON.stringify(preview);
    expect(previewText).toContain(`${ref} coffee supplies`);

    const csvCommit = await api.post<any>('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId,
      bulkImportId: randomUUID(),
      bulkSequence: 1,
      filename: `${ref}.csv`,
      fileType: 'csv',
      statementDate: today(),
      csvContent,
      bankFormat: 'fnb',
      applyBankRules: false,
    });
    expect(JSON.stringify(csvCommit)).toMatch(/imported|committed|2/);

    // ── MT940 import
    const ymd = today().slice(2).replace(/-/g, ''); // YYMMDD
    const mt940 = [
      ':20:GP-STMT-1',
      ':25:62012345678',
      ':28C:1/1',
      `:60F:C${ymd}ZAR1000,00`,
      `:61:${ymd}C300,00NTRF${ref}-M1`,
      `:86:${ref} mt940 credit`,
      `:62F:C${ymd}ZAR1300,00`,
    ].join('\n');

    const mtCommit = await api.post<any>('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId,
      bulkImportId: randomUUID(),
      bulkSequence: 1,
      filename: `${ref}.sta`,
      fileType: 'mt940',
      statementDate: today(),
      csvContent: mt940,
      bankFormat: 'mt940',
      applyBankRules: false,
    });
    expect(mtCommit).toBeTruthy();

    // ── All three transactions are queryable on the account. `status` is
    // required alongside bankAccountId for the search ILIKE branch to apply
    // (without it the endpoint ignores `search` and returns recent rows only,
    // which goes flaky once the account accumulates >50 same-day rows).
    const txns = await api.get<any>(
      `/api/accounting/bank-transactions?bankAccountId=${bankAccountId}&status=imported&search=${encodeURIComponent(ref)}`,
    );
    for (const t of txns?.transactions ?? (Array.isArray(txns) ? txns : [])) {
      if (t?.id) importedTxnIds.push(String(t.id));
    }
    const txnText = JSON.stringify(txns);
    expect(txnText).toContain(`${ref} coffee supplies`);
    expect(txnText).toContain(`${ref} client deposit`);
    expect(txnText).toContain(`${ref} mt940 credit`);

    // ── Rule machinery: preview a pattern match against the imported rows
    const rulePreview = await api.get<any>(
      `/api/accounting/bank-rules-preview?bankAccountId=${bankAccountId}&pattern=${encodeURIComponent(
        `${ref} coffee`,
      )}&matchType=contains&matchField=description`,
    );
    const count = Number(rulePreview.matchCount ?? 0);
    expect(count, 'rule preview must match the imported CSV transaction').toBeGreaterThan(0);
  } finally {
    // Cleanup: delete THIS run's imported statement lines so the shared bank
    // account (dev AND prod Demo post-deploy) doesn't grow a fake-txn tail
    // (late #196 review HIGH). Unallocated imports carry no GL impact.
    try {
      if (importedTxnIds.length > 0) {
        await api.post('/api/accounting/bank-transactions-action', {
          action: 'delete',
          bankTransactionIds: importedTxnIds,
        });
      }
    } catch (cleanupErr) {
      test.info().annotations.push({ type: 'cleanup-failed', description: String(cleanupErr) });
    }
    await api.dispose();
  }
});
