/**
 * One tax invoice, one VAT claim, at the moment a captured document is attached to a bank line (Hein, 2026-11-07).
 *
 * Refused: the line's journal claims input VAT and the document already backs a DIFFERENT VAT claim — a posted,
 * standing journal (source_document_id or an active link), a live bill with VAT, a live expense claim line with VAT.
 * Allowed: proof of payment (the line claims no VAT, or is not allocated yet), the line's OWN journal (a receipt
 * matched to its payment, a provisional journal), and a claim that no longer stands (reversed, cancelled, rejected).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

describeIfDb('Attaching a captured document to a bank line: one tax invoice, one VAT claim', () => {
  let fx: Fixture;
  let expenseAcc: string;
  let vatAcc: string;
  let employeeId: string;

  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, allocates bank lines and attaches documents.');
    fx = await seedFixture('ATTACHONE', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
    expenseAcc = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '7900', ${`Expense ${fx.tag}`}, 'asset', 'operating_expense', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    vatAcc = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND account_subtype = 'vat_input' AND is_active ORDER BY account_code LIMIT 1`) as Row[])[0]!.id);
    employeeId = String(((await sql`
      INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
      VALUES (${fx.companyId}::UUID, ${`E-${randomUUID().slice(0, 8)}`}, 'Claim', 'Ant', '2026-01-01') RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    const c = fx.companyId;
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID OR user_id = ${fx.userId}`;
    await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
    await sql`UPDATE captured_documents SET matched_invoice_id = NULL, matched_bank_tx_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE supplier_invoices SET source_document_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
  }, 120000);

  const slip = async (): Promise<string> => String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data, storage_bucket, storage_path)
    VALUES (${fx.companyId}::UUID, 'slip.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', '{"vatAmount":15}'::JSONB,
      'captured-documents', ${`${fx.companyId}/slip-${randomUUID()}.pdf`})
    RETURNING id`) as Row[])[0]!.id);

  /** A bank line; `vat` allocates it with 15% VAT (its journal claims input VAT), `plain` without, `none` leaves it. */
  async function line(alloc: 'vat' | 'plain' | 'none' = 'vat'): Promise<string> {
    const txId = await seedBankTx(fx, { date: '2026-07-16', amount: -115, description: 'card spend' });
    if (alloc !== 'none') {
      await inTx(fx, () => allocateTransaction(fx.companyId, txId, expenseAcc, fx.userId, 'alloc', 'account', undefined,
        alloc === 'vat' ? 'standard' : undefined));
    }
    return txId;
  }
  /** J1: a posted journal claiming R15 of input VAT, tied to `doc` by a link or by source_document_id (or not at all). */
  const claim = (doc?: string, by: 'link' | 'source' = 'link') => inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: '2026-07-12', description: 'receipt J1', source: 'manual', ...(doc && by === 'source' ? { sourceDocumentId: doc } : {}),
      lines: [{ glAccountId: vatAcc, debit: 15, credit: 0 }, { glAccountId: expenseAcc, debit: 0, credit: 15 }],
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    if (doc && by === 'link') await linkDocumentToJournal(fx.companyId, je.id, doc, fx.userId, 'Slip for J1');
    return je.id;
  });
  const attach = (doc: string, txId: string) => inTx(fx, () => attachCapturedDocToBankTx(fx.companyId, doc, txId, fx.userId));
  const linkedTo = async (doc: string) => ((await sql`SELECT matched_bank_tx_id FROM captured_documents
    WHERE id = ${doc}::UUID`) as Row[])[0]!.matched_bank_tx_id ?? null;

  for (const by of ['link', 'source'] as const) {
    it(`refuses a slip that backs J1 (${by}) on a line whose own journal claims VAT, writing nothing`, async () => {
      const d = await slip();
      const j1 = await claim(d, by);
      const txId = await line('vat');
      const r = await attach(d, txId);
      expect(r).toMatchObject({ ok: false, reason: 'document_backs_other_claim', otherClaim: { kind: 'journal', id: j1 } });
      expect(await linkedTo(d)).toBeNull();
      expect(((await sql`SELECT COUNT(*)::INT AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${txId}::UUID`) as Row[])[0]!.n).toBe(0);
    });
  }

  it('allows it as proof of payment: a line claiming no VAT, or not allocated yet', async () => {
    const d = await slip();
    await claim(d);
    expect((await attach(d, await line('plain'))).ok).toBe(true);
    const d2 = await slip();
    await claim(d2);
    expect((await attach(d2, await line('none'))).ok).toBe(true);
  });

  it('allows the line\'s OWN journal: a receipt matched to its payment, and a provisional journal', async () => {
    const d = await slip();
    const j1 = await claim(d, 'source');
    const matched = await line('none');
    await sql`UPDATE bank_transactions SET matched_journal_line_id = (SELECT id FROM gl_journal_lines
      WHERE journal_entry_id = ${j1}::UUID AND debit > 0 LIMIT 1), status = 'matched' WHERE id = ${matched}::UUID`;
    expect((await attach(d, matched)).ok).toBe(true);
    const d2 = await slip();
    const j2 = await claim(d2, 'source');
    const provisional = await line('none');
    await sql`UPDATE bank_transactions SET provisional_je_id = ${j2}::UUID WHERE id = ${provisional}::UUID`;
    expect((await attach(d2, provisional)).ok).toBe(true);
  });

  it('refuses on a provisional line whose journal claims VAT when the slip backs ANOTHER journal', async () => {
    const d = await slip();
    const j1 = await claim(d);
    const provisional = await line('none');
    await sql`UPDATE bank_transactions SET provisional_je_id = ${await claim()}::UUID WHERE id = ${provisional}::UUID`;
    expect(await attach(d, provisional)).toMatchObject({ ok: false, otherClaim: { kind: 'journal', id: j1 } });
  });

  it('allows a slip whose other claim was reversed', async () => {
    const d = await slip();
    const j1 = await claim(d);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, j1, fx.userId));
    expect((await attach(d, await line('vat'))).ok).toBe(true);
  });

  for (const by of ['source', 'matched'] as const) {
    it(`refuses a live bill's slip (${by}) with VAT, and allows it once the bill is cancelled`, async () => {
      const d = await slip();
      const bill = await seedBill(fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 115 });
      await sql`UPDATE supplier_invoices SET tax_amount = 15 WHERE id = ${bill}::UUID`;
      if (by === 'source') await sql`UPDATE supplier_invoices SET source_document_id = ${d}::UUID WHERE id = ${bill}::UUID`;
      else await sql`UPDATE captured_documents SET matched_invoice_id = ${bill}::UUID WHERE id = ${d}::UUID`;
      const txId = await line('vat');
      expect(await attach(d, txId)).toMatchObject({ ok: false, otherClaim: { kind: 'bill', id: bill } });
      await sql`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = ${bill}::UUID`;
      expect((await attach(d, txId)).ok).toBe(true);
    });
  }

  it('allows a bill\'s slip with no VAT on the bill', async () => {
    const d = await slip();
    const bill = await seedBill(fx, { number: `B-${randomUUID().slice(0, 8)}`, date: '2026-07-12', total: 100 });
    await sql`UPDATE supplier_invoices SET tax_amount = 0, source_document_id = ${d}::UUID WHERE id = ${bill}::UUID`;
    expect((await attach(d, await line('vat'))).ok).toBe(true);
  });

  it('refuses an expense claim line\'s slip with VAT, and allows it once the claim is rejected', async () => {
    const d = await slip();
    const claimId = String(((await sql`
      INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status)
      VALUES (${fx.companyId}::UUID, ${employeeId}::UUID, ${`EC-${randomUUID().slice(0, 8)}`}, '2026-07-12', 'approved')
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, amount, vat_amount, source_document_id)
      VALUES (${claimId}::UUID, ${fx.companyId}::UUID, '2026-07-12', 115, 15, ${d}::UUID)`;
    const txId = await line('vat');
    expect(await attach(d, txId)).toMatchObject({ ok: false, otherClaim: { kind: 'expense_claim', id: claimId } });
    await sql`UPDATE expense_claims SET status = 'rejected' WHERE id = ${claimId}::UUID`;
    expect((await attach(d, txId)).ok).toBe(true);
  });

  it('a slip with no other claim attaches to a VAT line as before', async () => {
    expect((await attach(await slip(), await line('vat'))).ok).toBe(true);
  });

  it('the one-off audit script finds a double use already in the data, and not a receipt matched to its own line', async () => {
    const audit = readFileSync(join(process.cwd(), 'scripts/audit/vat-document-double-use.sql'), 'utf8');
    const found = async () => ((await sql.unsafe(audit)) as Row[])
      .filter((r) => String(r.company) === String(companyName)).map((r) => String(r.document_id));
    const companyName = ((await sql`SELECT name FROM companies WHERE id = ${fx.companyId}::UUID`) as Row[])[0]!.name;
    // A double written before the guard existed: J1 claims on the slip AND the slip sits on a VAT-claiming line.
    const d = await slip();
    await claim(d);
    const txId = await line('vat');
    await sql`UPDATE captured_documents SET matched_bank_tx_id = ${txId}::UUID WHERE id = ${d}::UUID`;
    // A receipt matched to its own payment line is one claim.
    const own = await slip();
    const j = await claim(own, 'source');
    const matched = await line('none');
    await sql`UPDATE bank_transactions SET matched_journal_line_id = (SELECT id FROM gl_journal_lines
      WHERE journal_entry_id = ${j}::UUID AND debit > 0 LIMIT 1), status = 'matched' WHERE id = ${matched}::UUID`;
    await sql`UPDATE captured_documents SET matched_bank_tx_id = ${matched}::UUID WHERE id = ${own}::UUID`;
    const ids = await found();
    expect(ids).toContain(d);
    expect(ids).not.toContain(own);
  });
});
