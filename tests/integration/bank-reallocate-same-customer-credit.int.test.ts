/**
 * reallocate_bank_transaction to the SAME customer (review round 2, LOW 3 + security finding): cancelling the old
 * receipt removes its unapplied cash and the new receipt for the same customer puts cash back, minus whatever FIFO
 * applies — judged on the REAL rows the write leaves (`assertReallocationLeftCredit`, inside the reallocation's
 * savepoint; a dry run is the same write rolled back), never on a prediction of what FIFO will take. A re-point that
 * lowers nothing net passes (it used to be refused); one whose FIFO spends what a refund already returned is refused,
 * including when FIFO takes MORE than the open invoices read before the unwind (the old receipt's own invoices it
 * frees). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getCustomerOnAccountCredit } from '@/modules/accounting/services/ar/customerRefundDocument';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import { TOOL, arControlAndSubledger, lineRow, mcp, newBank, reconciledLine, setupCompany } from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const realloc = async (bt: string, target: Record<string, string>, autoApply: 'fifo' | 'none', dryRun = false) =>
  mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: String((await lineRow(bt)).je), target,
    auto_apply: autoApply, dry_run: dryRun, idempotency_key: randomUUID() });

async function customer(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO customers (id, company_id, name) VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${`SC ${id.slice(0, 6)}`})`;
  return id;
}
async function openInvoice(cust: string, total: number): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date, due_date,
      subtotal, tax_amount, total_amount, amount_paid, status, created_by)
    VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${cust}::UUID, ${cust}::UUID, ${`SC-${id.slice(0, 8)}`}, '2026-06-01', '2026-06-30',
      ${total}, 0, ${total}, 0, 'approved', ${c.fx.userId}::UUID)`;
  return id;
}
async function refund(cust: string, amount: number, date: string) {
  const bank = await newBank(c);
  const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${-amount}, ${`SC ${++c.seq}`},
      'imported') RETURNING id`) as Row[])[0]!.id);
  await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'customer', cust, 'none'));
}
const credit = async (cust: string) => (await getCustomerOnAccountCredit(c.fx.companyId, cust, '9999-12-31')).credit;

describe('reallocating a receipt to the same customer, after a refund', () => {
  beforeAll(async () => { c = await setupCompany('RASC'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('re-pointed with auto_apply "none", the new receipt puts back more than the old one\'s remainder: allowed', async () => {
    const cust = await customer();
    const inv = await openInvoice(cust, 300);
    const s = await reconciledLine(c, { amount: 1000, date: '2026-06-12', statementDate: '2026-06-30', alloc: 'customer', entity: cust, autoApply: 'fifo' });
    await refund(cust, 700, '2026-06-20'); // spends the receipt's whole unapplied 700
    expect(await credit(cust)).toBeCloseTo(0, 2);
    const dry = await realloc(s.bt, { customer_id: cust }, 'none', true);
    expect(dry.isError, dry.text).toBe(false);
    const r = await realloc(s.bt, { customer_id: cust }, 'none');
    expect({ err: r.isError, nothing: r.body?.nothing_changed ?? false }, r.text).toEqual({ err: false, nothing: false });
    const paid = Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as Row[])[0]!.amount_paid);
    expect({ credit: await credit(cust), paid }).toEqual({ credit: 300, paid: 0 });
    const ar = await arControlAndSubledger(c);
    expect(ar.control).toBe(ar.subledger);
  }, 120000);

  it('re-pointed with auto_apply "fifo" over an open invoice, spending what the refund returned: still refused', async () => {
    const cust = await customer();
    await openInvoice(cust, 300);
    const s = await reconciledLine(c, { amount: 1000, date: '2026-06-13', statementDate: '2026-06-30', alloc: 'customer', entity: cust, autoApply: 'none' });
    await refund(cust, 1000, '2026-06-21');
    const r = await realloc(s.bt, { customer_id: cust }, 'fifo');
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/owing the company/);
    expect(await credit(cust)).toBeCloseTo(0, 2);
  }, 120000);

  it('FIFO takes the invoice the old receipt frees as well: refused on the real outcome, dry and live', async () => {
    const cust = await customer();
    await openInvoice(cust, 600); // the old receipt settles this one…
    const s = await reconciledLine(c, { amount: 1000, date: '2026-06-14', statementDate: '2026-06-30', alloc: 'customer', entity: cust, autoApply: 'fifo' });
    await openInvoice(cust, 300); // …and this one opens after it
    await refund(cust, 350, '2026-06-22'); // running: 06-14 400, 06-22 50
    // A prediction from the invoices open now (300) says the new receipt keeps 700 > the old 400: "passes". The real
    // FIFO also takes the 600 the unwind frees: the new receipt keeps 100, and 06-22 ends at -250.
    for (const dryRun of [true, false]) {
      const r = await realloc(s.bt, { customer_id: cust }, 'fifo', dryRun);
      expect({ err: r.isError, dryRun }, r.text).toEqual({ err: true, dryRun });
      expect(r.text).toMatch(/owing the company/);
    }
    expect(await credit(cust)).toBeCloseTo(50, 2);
  }, 120000);
});
