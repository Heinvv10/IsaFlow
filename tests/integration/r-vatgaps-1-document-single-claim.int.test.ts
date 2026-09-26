/**
 * VAT-gaps batch item 1: one document, one claim, at the write side.
 * `createJournalEntry` refuses, before any write, a captured document already
 * referenced by a POSTED, UNREVERSED journal of the same company
 * (`documentJournalClaimGuard.ts`). First use still works; reuse after the
 * first journal is reversed is allowed again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { DocumentAlreadyPostedRefusal } from '@/modules/accounting/services/gl/documentJournalClaimGuard';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let expenseAcc: string;
let bankAcc: string;
let documentId: string;

function lines(a: string, b: string) {
  return [
    { glAccountId: a, debit: 100, credit: 0 },
    { glAccountId: b, debit: 0, credit: 100 },
  ];
}

describeIfDb('one document, one claim (createJournalEntry write side)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates journals against a captured document.');
    fx = await seedFixture('DOCCLAIM', DATABASE_URL!);
    expenseAcc = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '7900', ${`Expense ${fx.tag}`}, 'expense', 'operating_expense', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    bankAcc = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '1900', ${`Bank ${fx.tag}`}, 'asset', 'bank', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    documentId = String(((await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${fx.companyId}::UUID, 'invoice.pdf', 'application/pdf', 'reviewed', 'supplier_invoice')
      RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('allows the first journal to claim the document', async () => {
    const entry = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-05-01', description: 'First use', source: 'manual',
      sourceDocumentId: documentId, lines: lines(expenseAcc, bankAcc),
    }, fx.userId));
    expect(entry.id).toBeTruthy();
    await inTx(fx, () => postJournalEntry(fx.companyId, entry.id, fx.userId));
  });

  it('refuses a second journal on the same document once the first is posted, writing nothing', async () => {
    const before = Number(((await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);

    await expect(inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-05-02', description: 'Second use', source: 'manual',
      sourceDocumentId: documentId, lines: lines(expenseAcc, bankAcc),
    }, fx.userId))).rejects.toThrow(DocumentAlreadyPostedRefusal);

    const after = Number(((await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
    expect(after).toBe(before);
  });

  it('allows reuse after the first journal is reversed', async () => {
    const [firstRow] = (await sql`
      SELECT id FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND source_document_id = ${documentId}::UUID
      ORDER BY created_at ASC LIMIT 1`) as Row[];
    const firstId = String(firstRow!.id);

    await inTx(fx, () => reverseJournalEntry(fx.companyId, firstId, fx.userId));

    const entry = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-05-03', description: 'Reuse after reversal', source: 'manual',
      sourceDocumentId: documentId, lines: lines(expenseAcc, bankAcc),
    }, fx.userId));
    expect(entry.id).toBeTruthy();
  });
});
