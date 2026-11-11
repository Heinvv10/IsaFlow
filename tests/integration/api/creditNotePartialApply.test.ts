/**
 * Partial application, then cancel — the apply/un-apply amounts must agree.
 *
 * applyCreditNoteToInvoice credits min(total_amount, outstanding): a note worth
 * more than the invoice still owes is only PARTLY consumed. cancelCreditNote
 * used to un-credit total_amount unconditionally, so cancelling a partly-applied
 * note erased real cash receipts — an invoice of 1000 with 950 paid absorbs only
 * 50 of a 115 note, and un-crediting 115 left it showing 115 outstanding against
 * a true 50, with GREATEST(0, ...) silently absorbing the difference.
 *
 * Migration 529 records applied_amount and cancel reverses THAT. This has to run
 * against a database: the defect is in the arithmetic two SQL statements perform
 * on a real row, and a mocked sql tag asserts nothing about it.
 *
 * A company of its own (l1FifoFixture), never shared with another file:
 * journal entry numbering is not concurrency-safe across files posting for
 * the same company.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createCreditNote, approveCreditNote, applyCreditNoteToInvoice, cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { dropFixture, inTx as fxTx, seedFixture, type Fixture } from '../helpers/l1FifoFixture';

// A company of this suite's own (chart of accounts, open 2026 period), so it
// runs on a schema-only database too; it used to borrow dev's Demo company.
let fx: Fixture; let COMPANY: string; let USER: string;
let customer: string; let invoice: string;

const inTx = <T>(fn: () => Promise<T>): Promise<T> => fxTx(fx, fn);

beforeAll(async () => {
  fx = await seedFixture('CNPART', process.env.DATABASE_URL!);
  COMPANY = fx.companyId; USER = fx.userId; customer = fx.customerId;
  // approve posts DR revenue / CR receivable; the shared fixture has no revenue account.
  await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${COMPANY}::UUID, '4000', ${'Revenue ' + fx.tag}, 'revenue', 'default_revenue', 'credit', true, true)`;
  // total 1000, customer already paid 950 in CASH -> outstanding 50
  invoice = (await sql`INSERT INTO customer_invoices (company_id, client_id, customer_id, created_by, invoice_number, invoice_date, total_amount, amount_paid, status, subtotal)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${USER}::UUID, ${fx.tag}, '2026-06-01', 1000, 950, 'partially_paid', 1000) RETURNING id` as {id:string}[])[0]!.id;
}, 60_000);
afterAll(async () => {
  if (!fx) return;
  await sql`DELETE FROM credit_note_allocations WHERE company_id = ${COMPANY}::UUID`;
  await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
  await dropFixture(fx);
}, 60_000);

describe('partial application then cancel', () => {
  it('must not erase more than was applied', async () => {
    // standalone note (no link) for 115
    const cn = await inTx(() => createCreditNote(COMPANY, { type: 'customer', clientId: customer, creditDate: '2026-06-30', subtotal: 100, taxRate: 15 }, USER));
    // auto_apply 'none' because approving now applies a note FIFO to the
    // customer's open invoices (migration 677) — the default would consume this
    // very invoice at approval and leave the manual apply below nothing to do.
    // This test is about what a MANUAL apply consumes and what a cancel then
    // gives back, so the automatic walk is switched off to isolate it.
    await inTx(() => approveCreditNote(COMPANY, cn.id, USER, { autoApply: 'none' }));
    const applied = await inTx(() => applyCreditNoteToInvoice(COMPANY, cn.id, invoice, USER));
    // 'partially_applied', not 'applied': only 50 of the 115 was consumed, and
    // since migration 677 the status is DERIVED from that rather than set to
    // 'applied' the moment anything at all was applied. The old value is what
    // stranded the other 65 — an 'applied' note cannot be applied again.
    expect(applied.status).toBe('partially_applied');

    let inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id=${invoice}::UUID` as {amount_paid:string}[];
    // eslint-disable-next-line no-console
    console.log('AFTER APPLY amount_paid =', inv[0]!.amount_paid, '(expected 1000: 950 cash + 50 capped credit)');
    expect(Number(inv[0]!.amount_paid)).toBeCloseTo(1000, 2);

    await inTx(() => cancelCreditNote(COMPANY, cn.id, USER, 'partial-test'));
    inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id=${invoice}::UUID` as {amount_paid:string}[];
    // eslint-disable-next-line no-console
    console.log('AFTER CANCEL amount_paid =', inv[0]!.amount_paid, '(correct = 950; bug gives 885)');
    expect(Number(inv[0]!.amount_paid), 'cancel must restore the 950 cash, not erase 115').toBeCloseTo(950, 2);
  });
});
