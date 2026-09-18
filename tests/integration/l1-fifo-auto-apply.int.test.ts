/**
 * L1 — cash allocated to a supplier with no bill named settles that supplier's
 * oldest open bills, against a real ledger.
 *
 * WHAT WAS BROKEN. `allocateTransaction` created the payment document and then
 * asked the supplier's `auto_allocate_strategy` whether to apply it. That
 * column defaults to 'off' and nothing ever set it, so in production every one
 * of these payments sat at allocated 0 while the bills it obviously paid aged
 * another month.
 *
 * The reversal half is in l1-fifo-auto-apply-reversal.int.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice,
  seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

/** Every journal line of one entry, as an order-independent set. */
async function journalLines(entryId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT a.account_code, jl.debit::float8 AS dr, jl.credit::float8 AS cr
    FROM gl_journal_lines jl
    JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${entryId}::UUID
      AND jl.company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return rows
    .map((r) => `${String(r.account_code)}:${Number(r.dr).toFixed(2)}/${Number(r.cr).toFixed(2)}`)
    .sort();
}

async function allocationRows(paymentId: string): Promise<{ invoice: string; amount: number }[]> {
  const rows = (await sql`
    SELECT invoice_id, amount_allocated::float8 AS amount FROM payment_allocations
    WHERE payment_id = ${paymentId}::UUID ORDER BY amount_allocated DESC`) as Record<string, unknown>[];
  return rows.map((r) => ({ invoice: String(r.invoice_id), amount: Number(r.amount) }));
}

async function paymentFor(journalEntryId: string): Promise<{ id: string; status: string }> {
  const rows = (await sql`
    SELECT id, status FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID
      AND gl_journal_entry_id = ${journalEntryId}::UUID`) as Record<string, unknown>[];
  return { id: String(rows[0]!.id), status: String(rows[0]!.status) };
}

describeIfDb('L1 — a supplier bank line with no bill named', () => {
  beforeAll(async () => {
    fx = await seedFixture('L1', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await dropFixture(fx);
  }, 60000);

  it('settles the oldest bills in turn, part-paying the one the money runs out on', async () => {
    // A supplier of this test's own: every test here allocates with no bill
    // named, so a shared supplier would hand one test whatever the last one
    // left open.
    const sup = await seedSupplier(fx, 'B');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'B1', date: '2026-02-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'B2', date: '2026-02-02', total: 200 });
    const b3 = await seedBill(fx, { supplierId: sup, number: 'B3', date: '2026-02-03', total: 300 });
    const tx = await seedBankTx(fx, { date: '2026-03-01', amount: -250, description: 'EFT' });

    const result = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));

    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'partially_paid', amountPaid: 150 });
    expect(await billState(fx, b3)).toMatchObject({ status: 'approved', amountPaid: 0 });

    expect(result.application).toMatchObject({ autoApply: 'fifo', onAccount: 0 });
    expect(result.application!.applications.map((a) => a.amount)).toEqual([100, 150]);

    const payment = await paymentFor(result.journalEntryId);
    expect(await allocationRows(payment.id)).toEqual([
      { invoice: b2, amount: 150 },
      { invoice: b1, amount: 100 },
    ]);

    // THE JOURNAL IS UNCHANGED BY THE APPLICATION. Applying the payment moves
    // the subledger only; a second journal here would double the payment.
    const control = await seedBankTx(fx, { date: '2026-03-01', amount: -250, description: 'EFT-CTRL' });
    const none = await inTx(fx, () => allocateTransaction(
      fx.companyId, control, null, fx.userId, undefined, 'supplier', sup,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));
    expect(await journalLines(result.journalEntryId))
      .toEqual(await journalLines(none.journalEntryId));
  }, 60000);

  it('leaves the surplus on account when every bill is settled', async () => {
    const sup = await seedSupplier(fx, 'C');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'C1', date: '2026-04-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'C2', date: '2026-04-02', total: 200 });
    const b3 = await seedBill(fx, { supplierId: sup, number: 'C3', date: '2026-04-03', total: 300 });
    const tx = await seedBankTx(fx, { date: '2026-05-01', amount: -700, description: 'EFT-BIG' });

    const result = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));

    for (const b of [b1, b2, b3]) {
      expect(await billState(fx, b)).toMatchObject({ status: 'paid', paymentMatched: true });
    }
    expect(result.application!.onAccount).toBe(100);
    // Part-applied, so the payment keeps `processed` — a fully applied one
    // becomes `reconciled`.
    const payment = await paymentFor(result.journalEntryId);
    expect(payment.status).toBe('processed');
  }, 60000);

  it('puts the whole line on account when the supplier has nothing open', async () => {
    const sup = await seedSupplier(fx, 'NOBILL');
    const tx = await seedBankTx(fx, { date: '2026-06-01', amount: -500, description: 'EFT-NOBILL' });

    const result = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));

    // Not an error: the instruction was honoured and there was no bill. The
    // payment stays findable by list_unapplied_payments.
    expect(result.application).toMatchObject({ applications: [], onAccount: 500 });
    const payment = await paymentFor(result.journalEntryId);
    expect(await allocationRows(payment.id)).toEqual([]);
  }, 60000);

  it("applies nothing under auto_apply 'none', and touches no bill", async () => {
    const sup = await seedSupplier(fx, 'D');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'D1', date: '2026-07-01', total: 400 });
    const tx = await seedBankTx(fx, { date: '2026-07-05', amount: -400, description: 'EFT-NONE' });

    const result = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));

    expect(result.application).toMatchObject({ autoApply: 'none', applications: [], onAccount: 400 });
    expect(await billState(fx, b1)).toMatchObject({
      status: 'approved', amountPaid: 0, paymentMatched: false,
    });
    const payment = await paymentFor(result.journalEntryId);
    expect(await allocationRows(payment.id)).toEqual([]);
  }, 60000);

  it('skips a disputed bill and a cancelled one, and settles the next open bill', async () => {
    const sup = await seedSupplier(fx, 'E');
    const disputed = await seedBill(fx, {
      supplierId: sup, number: 'E1', date: '2026-08-01', total: 100, status: 'disputed',
    });
    const cancelled = await seedBill(fx, {
      supplierId: sup, number: 'E2', date: '2026-08-02', total: 100, status: 'cancelled',
    });
    const open = await seedBill(fx, { supplierId: sup, number: 'E3', date: '2026-08-03', total: 100 });
    const tx = await seedBankTx(fx, { date: '2026-08-10', amount: -100, description: 'EFT-DISP' });

    await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));

    // Cash must not quietly settle a bill the company is contesting, nor one
    // that has been cancelled.
    expect(await billState(fx, disputed)).toMatchObject({ status: 'disputed', amountPaid: 0 });
    expect(await billState(fx, cancelled)).toMatchObject({ status: 'cancelled', amountPaid: 0 });
    expect(await billState(fx, open)).toMatchObject({ status: 'paid', amountPaid: 100 });
  }, 60000);

  it('does not age a bill the payment predates', async () => {
    // A payment dated BEFORE the bill it settles is pathological but reachable
    // (a prepayment, a mis-dated statement line). The rewind keys on
    // supplier_payments.payment_date and the ageing admits a bill by
    // invoice_date, so the two answers below are the ones that must hold —
    // this test is the guard on that pair, not a change to either.
    const sup = await seedSupplier(fx, 'F');
    const bill = await seedBill(fx, { supplierId: sup, number: 'F1', date: '2026-09-10', total: 750 });
    const tx = await seedBankTx(fx, { date: '2026-09-05', amount: -750, description: 'EFT-EARLY' });

    await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));
    expect(await billState(fx, bill)).toMatchObject({ status: 'paid', amountPaid: 750 });

    const before = await getAPAgingDetail(fx.companyId, sup, '2026-09-09');
    expect(before.invoices.some((i) => i.id === bill)).toBe(false);

    const onDate = await getAPAgingDetail(fx.companyId, sup, '2026-09-10');
    // Settled, so it carries no balance on the day it was raised.
    const row = onDate.invoices.find((i) => i.id === bill);
    expect(row === undefined || Number(row.balance) === 0).toBe(true);
  }, 60000);

  it('mirrors the whole rule on the customer side', async () => {
    // AR is the twin, not a variation: a receipt with no invoice named settles
    // that customer's oldest open invoices on the same arithmetic.
    const i1 = await seedInvoice(fx, { number: 'G1', date: '2026-10-01', total: 100 });
    const i2 = await seedInvoice(fx, { number: 'G2', date: '2026-10-02', total: 200 });
    const tx = await seedBankTx(fx, { date: '2026-10-10', amount: 250, description: 'RECEIPT' });

    const result = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'customer', fx.customerId,
    ));

    expect(result.application).toMatchObject({ autoApply: 'fifo', onAccount: 0 });
    expect(result.application!.applications.map((a) => a.amount)).toEqual([100, 150]);

    const state = async (id: string) => {
      const rows = (await sql`
        SELECT status, amount_paid::float8 AS paid FROM customer_invoices
        WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
      return { status: String(rows[0]!.status), paid: Number(rows[0]!.paid) };
    };
    expect(await state(i1)).toEqual({ status: 'paid', paid: 100 });
    expect(await state(i2)).toEqual({ status: 'partially_paid', paid: 150 });
  }, 60000);
});
