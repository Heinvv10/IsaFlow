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
 * Deliberately a DIFFERENT company from creditNoteMcpTools.test.ts. Journal
 * entry numbering is not concurrency-safe — two files posting journals for the
 * same company in parallel collide on uq_gl_je_company_entry_number — so the
 * files are kept on separate tenants rather than serialised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createCreditNote, approveCreditNote, applyCreditNoteToInvoice, cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

const COMPANY = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-e2e0-000000000001';
const TAG = `PART-${Date.now()}`;
let pool: Pool; let customer: string; let invoice: string;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN');
    const o = await als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
    await c.query('COMMIT'); return o;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  customer = (await sql`INSERT INTO customers (name, company_id) VALUES (${'PART ' + TAG}, ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  // total 1000, customer already paid 950 in CASH -> outstanding 50
  invoice = (await sql`INSERT INTO customer_invoices (company_id, client_id, customer_id, created_by, invoice_number, invoice_date, total_amount, amount_paid, status, subtotal)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${USER}::UUID, ${TAG}, '2026-06-01', 1000, 950, 'partially_paid', 1000) RETURNING id` as {id:string}[])[0]!.id;
});
afterAll(async () => {
  const je = (await sql`SELECT gl_journal_entry_id AS id FROM credit_notes WHERE client_id=${customer}::UUID AND gl_journal_entry_id IS NOT NULL` as {id:string}[]).map(r=>r.id);
  await sql`DELETE FROM credit_notes WHERE client_id = ${customer}::UUID`;
  if (je.length) {
    const all = (await sql`SELECT id FROM gl_journal_entries WHERE id = ANY(${je}::UUID[]) OR reversal_of_id = ANY(${je}::UUID[])` as {id:string}[]).map(r=>r.id);
    await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id = ANY(${all}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE reversal_of_id = ANY(${je}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE id = ANY(${je}::UUID[])`;
  }
  await sql`DELETE FROM customer_invoices WHERE id = ${invoice}::UUID`;
  await sql`DELETE FROM customers WHERE id = ${customer}::UUID`;
  await pool.end();
});

describe('partial application then cancel', () => {
  it('must not erase more than was applied', async () => {
    // standalone note (no link) for 115
    const cn = await inTx(() => createCreditNote(COMPANY, { type: 'customer', clientId: customer, creditDate: '2026-06-30', subtotal: 100, taxRate: 15 }, USER));
    await inTx(() => approveCreditNote(COMPANY, cn.id, USER));
    const applied = await inTx(() => applyCreditNoteToInvoice(COMPANY, cn.id, invoice, USER));
    expect(applied.status).toBe('applied');

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
