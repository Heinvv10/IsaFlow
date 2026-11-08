/**
 * Shared fixture for the bank-attach VAT guard suites (bank-attach-one-claim*.int.test.ts): a company with an
 * expense account, its vat_input account, an employee, and helpers that make each kind of VAT claim on a captured
 * document and attach a document to a bank line.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import { dropFixture, inTx, seedBankTx, seedBill, seedFixture, type Fixture } from './l1FifoFixture';

export type Row = Record<string, unknown>;

export interface AttachGuard {
  fx: Fixture;
  expenseAcc: string;
  vatAcc: string;
  employeeId: string;
}

export async function setUpAttachGuard(prefix: string, databaseUrl: string): Promise<AttachGuard> {
  const fx = await seedFixture(prefix, databaseUrl);
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
  const expenseAcc = String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, '7900', ${`Expense ${fx.tag}`}, 'asset', 'operating_expense', 'debit', true)
    RETURNING id`) as Row[])[0]!.id);
  const vatAcc = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
    AND account_subtype = 'vat_input' AND is_active ORDER BY account_code LIMIT 1`) as Row[])[0]!.id);
  const employeeId = String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
    VALUES (${fx.companyId}::UUID, ${`E-${randomUUID().slice(0, 8)}`}, 'Claim', 'Ant', '2026-01-01') RETURNING id`) as Row[])[0]!.id);
  return { fx, expenseAcc, vatAcc, employeeId };
}

export async function tearDownAttachGuard(h: AttachGuard): Promise<void> {
  const c = h.fx.companyId;
  await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID OR user_id = ${h.fx.userId}`;
  await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
  await sql`UPDATE captured_documents SET matched_invoice_id = NULL, matched_bank_tx_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`UPDATE supplier_invoices SET source_document_id = NULL, gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM captured_documents WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM users WHERE id = ${h.fx.userId}`;
  await dropFixture(h.fx);
}

export const slip = async (h: AttachGuard): Promise<string> => String(((await sql`
  INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
  VALUES (${h.fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', '{"vatAmount":15}'::JSONB,
    'captured-documents', ${`${h.fx.companyId}/slip-${randomUUID()}.pdf`})
  RETURNING id`) as Row[])[0]!.id);

/** A bank line; `vat` allocates it with 15% VAT (its journal claims input VAT), `plain` without, `none` leaves it. */
export async function line(h: AttachGuard, alloc: 'vat' | 'plain' | 'none' = 'vat'): Promise<string> {
  const { fx } = h;
  const txId = await seedBankTx(fx, { date: '2026-07-16', amount: -115, description: 'card spend' });
  if (alloc !== 'none') {
    await inTx(fx, () => allocateTransaction(fx.companyId, txId, h.expenseAcc, fx.userId, 'alloc', 'account', undefined,
      alloc === 'vat' ? 'standard' : undefined));
  }
  return txId;
}

/**
 * J1: a journal with `vat` on vat_input (negative credits it), tied to `doc` by a link or by source_document_id (or
 * not at all). `draft` leaves it unposted.
 */
export const claim = (
  h: AttachGuard, doc?: string, by: 'link' | 'source' = 'link', opts: { vat?: number; draft?: boolean } = {},
) => inTx(h.fx, async () => {
  const { fx } = h;
  const vat = opts.vat ?? 15;
  const lines = vat >= 0
    ? [{ glAccountId: h.vatAcc, debit: vat, credit: 0 }, { glAccountId: h.expenseAcc, debit: 0, credit: vat }]
    : [{ glAccountId: h.vatAcc, debit: 0, credit: -vat }, { glAccountId: h.expenseAcc, debit: -vat, credit: 0 }];
  const je = await createJournalEntry(fx.companyId, {
    entryDate: '2026-07-12', description: 'receipt J1', source: 'manual',
    ...(doc && by === 'source' ? { sourceDocumentId: doc } : {}), lines,
  }, fx.userId);
  if (!opts.draft) await postJournalEntry(fx.companyId, je.id, fx.userId);
  if (doc && by === 'link') await linkDocumentToJournal(fx.companyId, je.id, doc, fx.userId, 'Slip for J1');
  return je.id;
});

/** A bill with `tax` VAT, tied to `doc` by source_document_id or the capture's matched_invoice_id. */
export async function billFor(
  h: AttachGuard, doc: string, opts: { by?: 'source' | 'matched'; tax?: number; status?: string; journalId?: string } = {},
): Promise<string> {
  const bill = await seedBill(h.fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 115, status: opts.status });
  await sql`UPDATE supplier_invoices SET tax_amount = ${opts.tax ?? 15}, gl_journal_entry_id = ${opts.journalId ?? null}::UUID
    WHERE id = ${bill}::UUID`;
  if ((opts.by ?? 'source') === 'source') await sql`UPDATE supplier_invoices SET source_document_id = ${doc}::UUID WHERE id = ${bill}::UUID`;
  else await sql`UPDATE captured_documents SET matched_invoice_id = ${bill}::UUID WHERE id = ${doc}::UUID`;
  return bill;
}

/** An expense claim in `status` with one line carrying `doc` and R15 VAT. */
export async function expenseClaimFor(h: AttachGuard, doc: string, status = 'approved', postedJe?: string): Promise<string> {
  const c = h.fx.companyId;
  const claimId = String(((await sql`
    INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status, posted_je_id)
    VALUES (${c}::UUID, ${h.employeeId}::UUID, ${`EC-${randomUUID().slice(0, 8)}`}, '2026-07-12', ${status}, ${postedJe ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, amount, vat_amount, source_document_id)
    VALUES (${claimId}::UUID, ${c}::UUID, '2026-07-12', 115, 15, ${doc}::UUID)`;
  return claimId;
}

/** The journal behind a bank line (its matched line's). */
export const lineJournal = async (txId: string): Promise<string> => String(((await sql`
  SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
  WHERE bt.id = ${txId}::UUID`) as Row[])[0]!.journal_entry_id);

/** Point a bank line at journal `je` as its matched line. */
export const matchLineTo = (txId: string, je: string) => sql`UPDATE bank_transactions SET matched_journal_line_id =
  (SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID AND debit > 0 LIMIT 1), status = 'matched'
  WHERE id = ${txId}::UUID`;

export const attach = (h: AttachGuard, doc: string, txId: string) =>
  inTx(h.fx, () => attachCapturedDocToBankTx(h.fx.companyId, doc, txId, h.fx.userId));

export const linkedTo = async (doc: string) => ((await sql`SELECT matched_bank_tx_id FROM captured_documents
  WHERE id = ${doc}::UUID`) as Row[])[0]!.matched_bank_tx_id ?? null;
