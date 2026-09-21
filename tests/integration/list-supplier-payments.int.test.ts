/**
 * listSupplierPayments against a real ledger.
 *
 * list_unapplied_payments shows only the unapplied remainder of processed
 * payments, so matching IsaFlow's supplier payments against a Sage export of
 * every payment was impossible. This lists them all, each with what it has
 * applied and what it has not, filterable the way a reconciliation needs, and
 * it must page to the end: a migration has thousands of payments and many
 * share a date, which an ORDER BY on the date alone would skip or repeat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { listSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentListService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let supB: string;
const SAME_DATE_COUNT = 23;

async function seedPayment(
  f: Fixture, args: { supplierId: string; date: string; amount: number; status?: string; ref?: string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_payments
      (company_id, supplier_id, payment_number, payment_date, total_amount, status, reference, created_by)
    VALUES (${f.companyId}::UUID, ${args.supplierId}::UUID, ${`PAY-${Math.random().toString(36).slice(2, 10)}`},
            ${args.date}::DATE, ${args.amount}, ${args.status ?? 'processed'}, ${args.ref ?? null}, ${f.userId}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function allocate(paymentId: string, invoiceId: string, amount: number): Promise<void> {
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
            VALUES (${paymentId}::UUID, ${invoiceId}::UUID, ${amount})`;
}

describeIfDb('listSupplierPayments — every payment, filterable, to the last page', () => {
  let partly: string;
  let full: string;

  beforeAll(async () => {
    assertNotProductionDb('This test creates supplier payments.');
    fx = await seedFixture('LSP', DATABASE_URL!);
    other = await seedFixture('LSX', DATABASE_URL!);
    supB = await seedSupplier(fx, 'LSP-B');
    const bill = await seedBill(fx, { number: 'LB1', date: '2026-03-01', total: 1000 });

    partly = await seedPayment(fx, { supplierId: fx.supplierId, date: '2026-03-02', amount: 300, ref: 'EFT-SAGE-001' });
    await allocate(partly, bill, 100);
    full = await seedPayment(fx, { supplierId: fx.supplierId, date: '2026-03-03', amount: 200, ref: 'EFT-SAGE-002' });
    await allocate(full, bill, 200);
    await seedPayment(fx, { supplierId: supB, date: '2026-03-04', amount: 50, status: 'draft' });
    for (let i = 0; i < SAME_DATE_COUNT; i++) {
      await seedPayment(fx, { supplierId: supB, date: '2026-04-01', amount: 10 + i });
    }
    // Another tenant's payment on the same day: must never appear.
    await seedPayment(other, { supplierId: other.supplierId, date: '2026-04-01', amount: 999 });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM payment_allocations WHERE payment_id IN (
        SELECT id FROM supplier_payments WHERE company_id = ${f.companyId}::UUID)`;
      await dropFixture(f);
    }
  }, 120000);

  it('reports each payment with what it applied and what it has not', async () => {
    const { rows } = await listSupplierPayments(fx.companyId, { supplierId: fx.supplierId, limit: 50, offset: 0 });
    const byId = new Map(rows.map((r) => [r.paymentId, r]));

    expect(byId.get(partly)).toMatchObject({ paymentAmount: 300, allocatedAmount: 100, unappliedAmount: 200, reference: 'EFT-SAGE-001' });
    expect(byId.get(full)).toMatchObject({ paymentAmount: 200, allocatedAmount: 200, unappliedAmount: 0 });
  });

  it('filters by supplier, status, date range and reference search', async () => {
    expect((await listSupplierPayments(fx.companyId, { supplierId: fx.supplierId, limit: 50, offset: 0 })).total).toBe(2);
    expect((await listSupplierPayments(fx.companyId, { status: 'draft', limit: 50, offset: 0 })).total).toBe(1);
    expect((await listSupplierPayments(fx.companyId, {
      fromDate: '2026-03-03', toDate: '2026-03-04', limit: 50, offset: 0,
    })).total).toBe(2);
    const found = await listSupplierPayments(fx.companyId, { search: 'sage-002', limit: 50, offset: 0 });
    expect(found.rows.map((r) => r.paymentId)).toEqual([full]);
  });

  it('totals the whole filter, not just the page', async () => {
    const page = await listSupplierPayments(fx.companyId, { supplierId: fx.supplierId, limit: 1, offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.totals).toEqual({ paymentAmount: 500, allocatedAmount: 300, unappliedAmount: 200 });
  });

  it('walks every payment exactly once, although many share a date', async () => {
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await listSupplierPayments(fx.companyId, { limit: 4, offset });
      seen.push(...page.rows.map((r) => r.paymentId));
      offset += page.rows.length;
      if (page.rows.length === 0 || offset >= page.total) break;
    }
    expect(seen).toHaveLength(3 + SAME_DATE_COUNT);
    expect(new Set(seen).size).toBe(3 + SAME_DATE_COUNT);
  });

  it('never returns another company\'s payment', async () => {
    const { rows, total } = await listSupplierPayments(fx.companyId, { fromDate: '2026-04-01', toDate: '2026-04-01', limit: 200, offset: 0 });
    expect(total).toBe(SAME_DATE_COUNT);
    expect(rows.every((r) => r.paymentAmount !== 999)).toBe(true);
  });
});
