/**
 * Shared fixture for the VAT input support "one tax invoice, one claim's worth" suites (r-vatgaps-1b / 1c).
 *
 * A company with an expense account and its vat_input account; helpers that post a VAT claim tied to a captured
 * document by each route the report knows (journal link, source_document_id, bill, expense claim line, bank line),
 * and `verdict`, which reads the report's judgement of one chain as 'ok', 'warn:<reason>' or 'block:<reason>'.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { findInputVatSupport } from '@/modules/accounting/services/reports/vatInputSupport';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { dropFixture, inTx, seedBankTx, seedBill, seedFixture, type Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;
export const PERIOD_START = '2026-07-01';
export const PERIOD_END = '2026-08-31';

export interface OneClaim {
  fx: Fixture;
  expenseAcc: string;
  vatAcc: string;
  employeeId: string;
}

export async function setUpOneClaim(prefix: string, databaseUrl: string): Promise<OneClaim> {
  const fx = await seedFixture(prefix, databaseUrl);
  // Linking a document to a journal writes an audit row against the user.
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

export async function tearDownOneClaim(h: OneClaim): Promise<void> {
  const c = h.fx.companyId;
  await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN
    (SELECT id FROM bank_transactions WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID OR user_id = ${h.fx.userId}`;
  await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
  await sql`UPDATE captured_documents SET matched_invoice_id = NULL, matched_bank_tx_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL, source_document_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`UPDATE gl_journal_entries SET late_claim_of_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM captured_documents WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM users WHERE id = ${h.fx.userId}`;
  await dropFixture(h.fx);
}

/** A bank line allocated with 15% VAT: J2, the journal whose claim the bank branch judges. */
export async function bankClaim(h: OneClaim, amount = -115, date = '2026-07-16'): Promise<{ txId: string; journalId: string }> {
  const { fx } = h;
  const txId = await seedBankTx(fx, { date, amount, description: 'bank-only VAT' });
  await inTx(fx, () => allocateTransaction(fx.companyId, txId, h.expenseAcc, fx.userId, 'alloc', 'account', undefined, 'standard'));
  const [r] = (await sql`
    SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.id = ${txId}::UUID AND bt.company_id = ${fx.companyId}::UUID`) as Row[];
  return { txId, journalId: String(r!.journal_entry_id) };
}

/** A captured tax invoice. `vat` is extracted_data.vatAmount as stored; `null` leaves it out (no VAT read). */
export async function slip(h: OneClaim, opts: { stored?: boolean; vat?: unknown } = {}): Promise<string> {
  const stored = opts.stored ?? true;
  const extracted = opts.vat === null ? {} : { vatAmount: opts.vat ?? 15 };
  return String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
    VALUES (${h.fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', ${JSON.stringify(extracted)}::JSONB,
      'captured-documents', ${stored ? `${h.fx.companyId}/slip-${randomUUID()}.pdf` : null})
    RETURNING id`) as Row[])[0]!.id);
}

/** J1: a posted journal claiming `vat` of input VAT, optionally tied to `doc` by a link or by source_document_id. */
export async function claim(
  h: OneClaim, opts: { doc?: string; by?: 'link' | 'source'; entryDate?: string; vat?: number } = {},
): Promise<string> {
  const { fx } = h;
  const vat = opts.vat ?? 15;
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: opts.entryDate ?? '2026-07-12', description: 'claim J1', source: 'manual',
      ...(opts.doc && opts.by === 'source' ? { sourceDocumentId: opts.doc } : {}),
      lines: [{ glAccountId: h.vatAcc, debit: vat, credit: 0 }, { glAccountId: h.expenseAcc, debit: 0, credit: vat }],
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    if (opts.doc && opts.by === 'link') await linkDocumentToJournal(fx.companyId, je.id, opts.doc, fx.userId, 'Slip for J1');
    return je.id;
  });
}

/** A posted bill whose journal is `journalId`, tied to `doc` by source_document_id or by the capture's matched_invoice_id. */
export async function billOn(h: OneClaim, journalId: string, doc: string, by: 'source' | 'matched'): Promise<string> {
  const billId = await seedBill(h.fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 115 });
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${journalId}::UUID,
    source_document_id = ${by === 'source' ? doc : null}::UUID WHERE id = ${billId}::UUID`;
  if (by === 'matched') await sql`UPDATE captured_documents SET matched_invoice_id = ${billId}::UUID WHERE id = ${doc}::UUID`;
  return billId;
}

/** A posted expense claim whose journal is `journalId`, one line per `lines` entry ({ doc, vat }). */
export async function expenseClaimOn(h: OneClaim, journalId: string, lines: { doc: string | null; vat: number }[]): Promise<string> {
  const c = h.fx.companyId;
  const claimId = String(((await sql`
    INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status, posted_je_id)
    VALUES (${c}::UUID, ${h.employeeId}::UUID, ${`EC-${randomUUID().slice(0, 8)}`}, '2026-07-12', 'posted', ${journalId}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  for (const l of lines) {
    await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, amount, vat_amount, source_document_id)
      VALUES (${claimId}::UUID, ${c}::UUID, '2026-07-12', ${l.vat * 23 / 3}, ${l.vat}, ${l.doc}::UUID)`;
  }
  return claimId;
}

export const linkToLine = (doc: string, txId: string) =>
  sql`UPDATE captured_documents SET matched_bank_tx_id = ${txId}::UUID, status = 'matched' WHERE id = ${doc}::UUID`;
export const copyOnLine = (doc: string, txId: string) => sql`
  INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
  VALUES (${txId}::UUID, ${`${doc}_slip.pdf`}, 'data:application/pdf;base64,JVBERi0=')`;

/** The report's judgement of the chain rooted at `journalId`: 'ok' (supported or not listed), 'warn:…' or 'block:…'. */
export async function verdict(h: OneClaim, journalId: string, start = PERIOD_START, end = PERIOD_END): Promise<string> {
  const r = await inTx(h.fx, () => findInputVatSupport(h.fx.companyId, start, end));
  const blocked = r.unsupported.find((l) => l.journalEntryId === journalId);
  if (blocked) return `block:${blocked.reason}`;
  const warned = r.withoutTaxInvoice.find((l) => l.journalEntryId === journalId);
  return warned ? `warn:${warned.reason}` : 'ok';
}
