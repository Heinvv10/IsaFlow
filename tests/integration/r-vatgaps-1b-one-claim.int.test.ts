/**
 * One tax invoice backs one VAT claim (Hein, 2026-11-07), on the VAT input support report's bank branch.
 *
 * A bank-allocated journal J2 is "tax invoice on file" when a document sits on its bank line (has_bank_attachment).
 * A captured slip D that already backs a claim on a DIFFERENT underlying journal J1 (a document link, or J1's
 * source_document_id) must not also count for J2: that is R30 of VAT on one R15 slip. The rule covers D linked to the
 * line and D's copy there; a reversed J1 frees D; a plain upload is untouched; a late-claim companion shares its
 * original's journal, so it is never "another" claim. VAT only: the grid and MCP keep counting D as a file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { linkDocumentToJournal, unlinkDocumentFromJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { findInputVatSupport } from '@/modules/accounting/services/reports/vatInputSupport';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
const PERIOD_START = '2026-07-01';
const PERIOD_END = '2026-08-31';

describeIfDb('VAT input support: one tax invoice, one claim', () => {
  let fx: Fixture;
  let expenseAcc: string;
  let vatAcc: string;

  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and links documents.');
    fx = await seedFixture('ONECLAIM', DATABASE_URL!);
    // Linking a document to a journal writes an audit row against the user.
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
    expenseAcc = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '7900', ${`Expense ${fx.tag}`}, 'asset', 'operating_expense', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    vatAcc = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND account_subtype = 'vat_input' AND is_active ORDER BY account_code LIMIT 1`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN
      (SELECT id FROM bank_transactions WHERE company_id = ${fx.companyId}::UUID)`;
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID OR user_id = ${fx.userId}`;
    await sql`UPDATE gl_journal_entries SET late_claim_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
  }, 120000);

  /** A bank line allocated with 15% VAT: J2, the journal whose claim the bank branch judges. */
  async function bankClaim(): Promise<{ txId: string; journalId: string }> {
    const txId = await seedBankTx(fx, { date: '2026-07-16', amount: -115, description: 'bank-only VAT' });
    await inTx(fx, () => allocateTransaction(fx.companyId, txId, expenseAcc, fx.userId, 'alloc', 'account', undefined, 'standard'));
    const [r] = (await sql`
      SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
      WHERE bt.id = ${txId}::UUID AND bt.company_id = ${fx.companyId}::UUID`) as Row[];
    return { txId, journalId: String(r!.journal_entry_id) };
  }
  async function slip(stored = true): Promise<string> {
    return String(((await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
      VALUES (${fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', ${JSON.stringify({ vatAmount: 15 })}::JSONB,
        'captured-documents', ${stored ? `${fx.companyId}/slip-${randomUUID()}.pdf` : null})
      RETURNING id`) as Row[])[0]!.id);
  }
  /** J1: a posted journal claiming R15 VAT, tied to `doc` by a document link or by source_document_id. */
  async function claimBackedBy(doc: string, by: 'link' | 'source', entryDate = '2026-07-12'): Promise<string> {
    return inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, {
        entryDate, description: 'receipt J1', source: 'manual', ...(by === 'source' ? { sourceDocumentId: doc } : {}),
        lines: [{ glAccountId: vatAcc, debit: 15, credit: 0 }, { glAccountId: expenseAcc, debit: 0, credit: 15 }],
      }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      if (by === 'link') await linkDocumentToJournal(fx.companyId, je.id, doc, fx.userId, 'Slip for J1');
      return je.id;
    });
  }
  const withoutTaxInvoice = async (journalId: string) => (await inTx(fx, () =>
    findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END))).withoutTaxInvoice.some((l) => l.journalEntryId === journalId);
  const linkToLine = (doc: string, txId: string) =>
    sql`UPDATE captured_documents SET matched_bank_tx_id = ${txId}::UUID, status = 'matched' WHERE id = ${doc}::UUID`;
  const copyOnLine = (doc: string, txId: string) => sql`
    INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
    VALUES (${txId}::UUID, ${`${doc}_slip.pdf`}, 'data:application/pdf;base64,JVBERi0=')`;

  it('a slip linked to the line does not support it while it backs another claim, and does once that claim is reversed', async () => {
    const { txId, journalId } = await bankClaim();
    const d = await slip();
    const j1 = await claimBackedBy(d, 'link');
    await linkToLine(d, txId);
    expect(await withoutTaxInvoice(journalId)).toBe(true);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, j1, fx.userId));
    expect(await withoutTaxInvoice(journalId)).toBe(false);
  });

  it('the same when the other claim holds the slip as its source_document_id', async () => {
    const { txId, journalId } = await bankClaim();
    const d = await slip();
    await claimBackedBy(d, 'source');
    await linkToLine(d, txId);
    expect(await withoutTaxInvoice(journalId)).toBe(true);
  });

  it('a slip\'s copy on the line follows the same rule (a slip with no stored bytes counts only through its copy)', async () => {
    const { txId, journalId } = await bankClaim();
    const d = await slip(false);
    const j1 = await claimBackedBy(d, 'link');
    await linkToLine(d, txId);
    await copyOnLine(d, txId);
    expect(await withoutTaxInvoice(journalId)).toBe(true);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, j1, fx.userId));
    expect(await withoutTaxInvoice(journalId)).toBe(false);
  });

  it('the copy of a rejected slip supports nothing, as the slip itself would not', async () => {
    const { txId, journalId } = await bankClaim();
    const d = await slip(false);
    await linkToLine(d, txId);
    await copyOnLine(d, txId);
    expect(await withoutTaxInvoice(journalId)).toBe(false);
    await sql`UPDATE captured_documents SET status = 'rejected' WHERE id = ${d}::UUID`;
    expect(await withoutTaxInvoice(journalId)).toBe(true);
  });

  for (const via of ['link', 'copy'] as const) {
    it(`a slip once linked to the bank line's OWN journal still supports that line (${via})`, async () => {
      const { txId, journalId } = await bankClaim();
      const d = await slip(via === 'link');
      // J2 itself carried D and was unlinked from it: D is J2's own history, not another claim's.
      await inTx(fx, () => linkDocumentToJournal(fx.companyId, journalId, d, fx.userId, 'Slip for J2'));
      await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, journalId, d, fx.userId, 'Moved to the bank line'));
      await linkToLine(d, txId);
      if (via === 'copy') await copyOnLine(d, txId);
      expect(await withoutTaxInvoice(journalId)).toBe(false);
    });
  }

  it('a late-claim companion shares its original\'s journal: the original\'s own slip still supports the companion', async () => {
    const { txId, journalId } = await bankClaim();
    const d = await slip();
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, journalId, d, fx.userId, 'Slip for J2'));
    await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, journalId, d, fx.userId, 'Moved to the bank line'));
    await linkToLine(d, txId);
    // The companion claims more of the same invoice later; its claims are judged on J2, its original.
    const companion = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, {
        entryDate: '2026-07-20', description: 'late claim of J2', source: 'manual',
        lines: [{ glAccountId: vatAcc, debit: 5, credit: 0 }, { glAccountId: expenseAcc, debit: 0, credit: 5 }],
      }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
    await sql`UPDATE gl_journal_entries SET late_claim_of_id = ${journalId}::UUID WHERE id = ${companion}::UUID`;
    expect(await withoutTaxInvoice(companion)).toBe(false);
    expect(await withoutTaxInvoice(journalId)).toBe(false);
  });

  it('a slip backing nothing else, or a plain upload, still supports the bank line\'s claim', async () => {
    const { txId, journalId } = await bankClaim();
    const free = await slip();
    await linkToLine(free, txId);
    expect(await withoutTaxInvoice(journalId)).toBe(false);
    await sql`UPDATE captured_documents SET matched_bank_tx_id = NULL WHERE id = ${free}::UUID`;
    expect(await withoutTaxInvoice(journalId)).toBe(true);
    // A plain upload is no captured document's copy, so the rule never reaches it, even while another slip of the
    // company backs another claim.
    await claimBackedBy(await slip(), 'link');
    await sql`INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
      VALUES (${txId}::UUID, 'till-slip.png', 'data:image/png;base64,iVBORw0KGgo=')`;
    expect(await withoutTaxInvoice(journalId)).toBe(false);
  });
});
