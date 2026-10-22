/**
 * FIFO cash clears a one-cent customer remnant; the AP side keeps its cent floor.
 *
 * planGreedyAllocations skipped any line of a cent or less, so cash could never settle the last cent of a customer
 * invoice (which now reads 'partially_paid' and sits in the open set). The floor is side-aware: exact for customer
 * invoices, the cent tolerance for supplier bills. The dry-run preview and the live apply share the planner, so each
 * case also asserts that the preview and the live result are the same lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { applyCreditNote } from '@/modules/accounting/services/shared/creditNoteFifo';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { previewBatchApplications } from '@/lib/mcp/tools/bulkAutoApplyPreview';
import type { ResolvedLine } from '@/lib/mcp/tools/bulkAllocationPrepare';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function seedCustomer(name: string): Promise<string> {
  return ((await sql`INSERT INTO customers (name, company_id) VALUES (${`${name} ${fx.tag}`}, ${fx.companyId}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function invoiceRow(id: string): Promise<{ status: string; paid: number }> {
  const r = ((await sql`SELECT status, amount_paid::float8 AS paid FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), paid: Number(r.paid) };
}

/** The line a bulk allocation would post for this bank row, as the preview consumes it. */
function resolved(txId: string, allocType: 'customer' | 'supplier', entityId: string, signedAmount: number): ResolvedLine {
  return { index: 0, txId, signedAmount, line: { allocType, entityId, autoApply: 'fifo' } } as unknown as ResolvedLine;
}

const amounts = (apps: { amount: number }[]) => apps.map((a) => a.amount);

describeIfDb('FIFO cash and the cent floor', () => {
  beforeAll(async () => { fx = await seedFixture('FCX', DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropFixture(fx); }, 120000);

  it('customer: cash clears a one-cent remnant; preview and live apply the same lines', async () => {
    const cust = await seedCustomer('CUS-A');
    const big = await seedInvoice(fx, { number: 'F1', date: '2026-10-01', total: 100, customerId: cust });
    const cent = await seedInvoice(fx, { number: 'F2', date: '2026-10-02', total: 0.01, customerId: cust });
    const tx = await seedBankTx(fx, { date: '2026-10-10', amount: 100.01, description: 'RECEIPT' });

    const preview = await inTx(fx, () => previewBatchApplications(fx.companyId, [resolved(tx, 'customer', cust, 100.01)]));
    const live = await inTx(fx, () => allocateTransaction(fx.companyId, tx, null, fx.userId, undefined, 'customer', cust));

    expect(amounts(live.application!.applications)).toEqual([100, 0.01]);
    expect(live.application!.onAccount).toBe(0);
    expect(amounts(preview.get(0)!.applications)).toEqual([100, 0.01]);
    expect(preview.get(0)!.onAccount).toBe(0);
    expect(await invoiceRow(big)).toEqual({ status: 'paid', paid: 100 });
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
  }, 60000);

  it('customer: a bare cent of cash settles a one-cent remnant', async () => {
    const cust = await seedCustomer('CUS-B');
    const cent = await seedInvoice(fx, { number: 'F3', date: '2026-10-01', total: 0.01, customerId: cust });
    const tx = await seedBankTx(fx, { date: '2026-10-11', amount: 0.01, description: 'RECEIPT' });

    const preview = await inTx(fx, () => previewBatchApplications(fx.companyId, [resolved(tx, 'customer', cust, 0.01)]));
    const live = await inTx(fx, () => allocateTransaction(fx.companyId, tx, null, fx.userId, undefined, 'customer', cust));

    expect(amounts(live.application!.applications)).toEqual([0.01]);
    expect(amounts(preview.get(0)!.applications)).toEqual([0.01]);
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
  }, 60000);

  it('customer back-fill: the dry run plans, and the live run writes, the same lines including the last cent', async () => {
    const cust = await seedCustomer('CUS-C');
    // The receipt is recorded first with nothing applied, as production left them.
    const tx = await seedBankTx(fx, { date: '2026-10-12', amount: 100.01, description: 'RECEIPT' });
    await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'customer', cust,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));
    const big = await seedInvoice(fx, { number: 'F4', date: '2026-10-01', total: 100, customerId: cust });
    const cent = await seedInvoice(fx, { number: 'F5', date: '2026-10-02', total: 0.01, customerId: cust });
    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ar' as const, entityId: cust };
    const lines = (plan: Awaited<ReturnType<typeof autoApplyUnapplied>>) =>
      plan.applications.map((a) => ({ lines: a.lines.map((l) => [l.document_id, l.amount]), on_account: a.on_account_after }));

    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: false, idempotencyKey: 'fcx-ar-1' }));

    expect(live.failed).toEqual([]);
    expect(lines(dry)).toEqual([{ lines: [[big, 100], [cent, 0.01]], on_account: 0 }]);
    expect(lines(live)).toEqual(lines(dry));
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
  }, 60000);

  it('customer credit note FIFO: a note clears the last cent too', async () => {
    const cust = await seedCustomer('CUS-D');
    const big = await seedInvoice(fx, { number: 'F6', date: '2026-10-01', total: 100, customerId: cust });
    const cent = await seedInvoice(fx, { number: 'F7', date: '2026-10-02', total: 0.01, customerId: cust });
    const je = String(((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at)
      VALUES (${fx.companyId}::UUID, ${`JE-FCN-${fx.tag}`}, '2026-10-05'::DATE, 'CN', 'posted', ${fx.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW())
      RETURNING id`) as { id: string }[])[0]!.id);
    const note = String(((await sql`
      INSERT INTO credit_notes (company_id, type, client_id, credit_note_number, credit_date, subtotal, total_amount,
                                applied_amount, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, 'customer', ${cust}::UUID, ${`FCN-${fx.tag}`}, '2026-10-05'::DATE, 100.01, 100.01,
              0, 'approved', ${fx.userId}::UUID, ${je}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id);

    const out = await inTx(fx, () => applyCreditNote({
      companyId: fx.companyId, creditNoteId: note, side: 'customer', entityId: cust, totalAmount: 100.01,
      linkedInvoiceId: null, autoApply: 'fifo',
    }));

    expect(out.lines.map((l) => l.amount)).toEqual([100, 0.01]);
    expect(await invoiceRow(big)).toEqual({ status: 'paid', paid: 100 });
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id = ${note}::UUID`;
    await sql`DELETE FROM credit_notes WHERE id = ${note}::UUID`;
  }, 60000);

  it('supplier: unchanged - a cent of cash left over is not applied to a bill, preview and live agree', async () => {
    const sup = await seedSupplier(fx, 'SUP-A');
    const big = await seedBill(fx, { number: 'B1', date: '2026-10-01', total: 100, supplierId: sup });
    const small = await seedBill(fx, { number: 'B2', date: '2026-10-02', total: 0.02, supplierId: sup });
    const tx = await seedBankTx(fx, { date: '2026-10-10', amount: -100.01, description: 'PAYMENT' });

    const preview = await inTx(fx, () => previewBatchApplications(fx.companyId, [resolved(tx, 'supplier', sup, -100.01)]));
    const live = await inTx(fx, () => allocateTransaction(fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup));

    expect(amounts(live.application!.applications)).toEqual([100]);
    expect(live.application!.onAccount).toBe(0.01);
    expect(amounts(preview.get(0)!.applications)).toEqual([100]);
    expect(preview.get(0)!.onAccount).toBe(0.01);
    expect(await billState(fx, big)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, small)).toMatchObject({ amountPaid: 0 });
  }, 60000);
});
