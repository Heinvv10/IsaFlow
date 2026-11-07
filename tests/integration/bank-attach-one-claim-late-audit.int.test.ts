/**
 * Bank-attach VAT guard and the one-off audit (scripts/audit/vat-document-double-use.sql), part 3:
 *  - a section 16(3) late claim parks the original journal's VAT on the clearing account (vat_input_late_claim); it is
 *    still that journal's claim, on either side of the attach;
 *  - the audit finds doubles already in the data (journal, bill, expense claim on a VAT line; a late claim; a journal
 *    reversed twice), and not a receipt matched to its own payment line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx, seedBill } from './helpers/l1FifoFixture';
import { dropLateFixture, lockPeriod, P, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
const late = { allowLateInputClaim: true };

describeIfDb('Bank-attach VAT guard: late claims, and the one-off audit', () => {
  let fx: LateFixture;
  let employeeId: string;
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, locks a VAT period, allocates bank lines and attaches documents.');
    fx = await seedLateFixture('ATTACHLATE', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
    employeeId = String(((await sql`
      INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
      VALUES (${fx.companyId}::UUID, ${`E-${randomUUID().slice(0, 8)}`}, 'Claim', 'Ant', '2026-01-01') RETURNING id`) as Row[])[0]!.id);
    await lockPeriod(fx, P.start, P.end);
  }, 120000);
  afterAll(async () => {
    const c = fx.companyId;
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID OR user_id = ${fx.userId}`;
    await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
    await sql`UPDATE captured_documents SET matched_bank_tx_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE supplier_invoices SET source_document_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
    await sql`UPDATE gl_journal_entries SET source_document_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropLateFixture(fx);
  }, 120000);

  const slip = async (): Promise<string> => String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
    VALUES (${fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', '{"vatAmount":15}'::JSONB,
      'captured-documents', ${`${fx.companyId}/slip-${randomUUID()}.pdf`})
    RETURNING id`) as Row[])[0]!.id);
  /** J1 on `doc` (source_document_id): R15 input VAT, dated in the filed period as a late claim, or in the open one. */
  const claim = (doc: string | null, lateClaim: boolean) => inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: lateClaim ? '2026-06-12' : '2026-07-12', description: 'J1', source: 'manual',
      ...(doc ? { sourceDocumentId: doc } : {}),
      lines: [{ glAccountId: fx.vatInputId, debit: 15, credit: 0 }, { glAccountId: fx.expenseId, debit: 100, credit: 0 },
        { glAccountId: fx.apId, debit: 0, credit: 115 }],
    }, fx.userId, undefined, lateClaim ? late : undefined);
    await postJournalEntry(fx.companyId, je.id, fx.userId, lateClaim ? late : undefined);
    return je.id;
  });
  /** A bank line allocated with VAT, as a late claim in the filed period or in the open one. */
  async function vatLine(lateClaim: boolean): Promise<string> {
    const tx = await seedBankTx(fx, { date: lateClaim ? '2026-06-15' : '2026-07-16', amount: -115, description: 'card' });
    await inTx(fx, () => allocateTransaction(fx.companyId, tx, fx.expenseId, fx.userId, 'alloc', 'account', undefined, 'standard',
      undefined, undefined, undefined, undefined, lateClaim ? late : undefined));
    return tx;
  }
  const attach = (doc: string, tx: string) => inTx(fx, () => attachCapturedDocToBankTx(fx.companyId, doc, tx, fx.userId));
  const vatInputLines = async (tx: string) => Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM bank_transactions bt JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id
    JOIN gl_journal_lines jl ON jl.journal_entry_id = ml.journal_entry_id JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE bt.id = ${tx}::UUID AND ga.account_subtype = 'vat_input'`) as Row[])[0]!.n);

  it('refuses a slip whose other claim is a LATE claim (its VAT sits on the clearing account)', async () => {
    const d = await slip();
    const j1 = await claim(d, true);
    expect(await attach(d, await vatLine(false))).toMatchObject({ ok: false, otherClaim: { kind: 'journal', id: j1 } });
  });

  it('refuses when the LINE ITSELF is a late claim', async () => {
    const d = await slip();
    const bill = await seedBill(fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 115 });
    await sql`UPDATE supplier_invoices SET tax_amount = 15, source_document_id = ${d}::UUID WHERE id = ${bill}::UUID`;
    const tx = await vatLine(true);
    expect(await vatInputLines(tx)).toBe(0); // the line's journal carries its VAT on the clearing account only
    expect(await attach(d, tx)).toMatchObject({ ok: false, otherClaim: { kind: 'bill', id: bill } });
  });

  it('the audit finds doubles already in the data, and not a receipt matched to its own line', async () => {
    const audit = readFileSync(join(process.cwd(), 'scripts/audit/vat-document-double-use.sql'), 'utf8');
    const name = String(((await sql`SELECT name FROM companies WHERE id = ${fx.companyId}::UUID`) as Row[])[0]!.name);
    const onLine = (doc: string, tx: string) => sql`UPDATE captured_documents SET matched_bank_tx_id = ${tx}::UUID WHERE id = ${doc}::UUID`;
    // Written before the guard existed, so set directly.
    const journalDoc = await slip();
    await claim(journalDoc, false);
    await onLine(journalDoc, await vatLine(false));
    const lateDoc = await slip();
    await claim(lateDoc, true);
    await onLine(lateDoc, await vatLine(false));
    const twiceReversed = await slip();
    const j = await claim(twiceReversed, false);
    const r1 = await inTx(fx, () => reverseJournalEntry(fx.companyId, j, fx.userId));
    await inTx(fx, () => reverseJournalEntry(fx.companyId, String((r1 as { id?: string }).id ?? r1), fx.userId));
    await onLine(twiceReversed, await vatLine(false));
    const billDoc = await slip();
    const bill = await seedBill(fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 115 });
    await sql`UPDATE supplier_invoices SET tax_amount = 15, source_document_id = ${billDoc}::UUID WHERE id = ${bill}::UUID`;
    await onLine(billDoc, await vatLine(false));
    const claimDoc = await slip();
    const claimId = String(((await sql`
      INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status)
      VALUES (${fx.companyId}::UUID, ${employeeId}::UUID, ${`EC-${randomUUID().slice(0, 8)}`}, '2026-07-12', 'approved')
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, amount, vat_amount, source_document_id)
      VALUES (${claimId}::UUID, ${fx.companyId}::UUID, '2026-07-12', 115, 15, ${claimDoc}::UUID)`;
    await onLine(claimDoc, await vatLine(false));
    const own = await slip();
    const ownJe = await claim(own, false);
    const ownTx = await seedBankTx(fx, { date: '2026-07-16', amount: -115, description: 'paid J' });
    await sql`UPDATE bank_transactions SET matched_journal_line_id = (SELECT id FROM gl_journal_lines
      WHERE journal_entry_id = ${ownJe}::UUID AND debit > 0 LIMIT 1), status = 'matched' WHERE id = ${ownTx}::UUID`;
    await onLine(own, ownTx);

    const ids = ((await sql.unsafe(audit)) as Row[]).filter((r) => String(r.company) === name).map((r) => String(r.document_id));
    for (const d of [journalDoc, lateDoc, twiceReversed, billDoc, claimDoc]) expect(ids).toContain(d);
    expect(ids).not.toContain(own);
  });
});
