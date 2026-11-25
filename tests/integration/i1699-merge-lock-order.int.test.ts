/**
 * #1699, the breaker of aad49a02: writers of a supplier being merged, against the REAL merge (helpers/mergeRace), on PostgreSQL as
 * app_user.
 *   M1  a bill create naming a PO of the source takes the supplier FIRST (lockSupplierIfLive): it used to take the PO FOR KEY SHARE
 *       and the supplier only at the INSERT's FK, while the merge takes the supplier FOR UPDATE and then the source's POs: 40P01.
 *   H1  a supplier payment (createSupplierPayment), a payment batch (createBatch) and a bank-line supplier payment
 *       (validateBankSupplierPayment) wait for a merge of their payee and are then refused before any write; migration 1023's
 *       trigger refuses a payment written onto a merged-away supplier by any writer.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { dropGrnExtras, dropMaintExtras, seedQtyPo } from './helpers/grnHarness';
import { dropMergeRaceExtras, holdRow, pausedMerge, startRequest, waitsOnLock } from './helpers/mergeRace';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { BillSupplierDeletedError } from '@/modules/accounting/services/ap/billSupplierLive';
import { createSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { createBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { validateBankSupplierPayment } from '@/modules/accounting/services/ap/supplierBankPaymentService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { SUPPLIER_NOT_LIVE_REFUSAL } from '@/modules/accounting/services/core/supplierLiveLock';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => { await pool.end(); });

async function withFixture(tag: string, fn: (fx: BillFixture, target: string) => Promise<void>) {
  const fx = await seedBillFixture(pool, tag);
  const target = await seedSupplier(pool, fx, `${tag} target`);
  try { await fn(fx, target); } finally {
    await dropMergeRaceExtras(pool, fx); await dropGrnExtras(pool, fx); await dropMaintExtras(pool, fx); await dropBillFixture(pool, fx);
  }
}
const deadlocks = async () => Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
const liveOn = async (table: string, supplier: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE supplier_id = $1`, [supplier])).rows[0].n);

describe('M1: a bill create naming a PO of the source, against a merge (no 40P01)', () => {
  it('the merge queued first on the supplier wins; the bill then finds its supplier merged away (typed refusal); no deadlock', async () => {
    await withFixture('i1699-m1', async (fx, target) => {
      const po = await seedQtyPo(pool, fx, { lines: [{ qty: 2, price: 10 }] });
      const before = await deadlocks();
      // Both writers queue behind a held supplier row: the merge first (FOR UPDATE), then the bill.
      const hold = await holdRow(pool, 'SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [fx.supplier]);
      let merge: Awaited<ReturnType<typeof startRequest>> | undefined;
      let bill: Awaited<ReturnType<typeof startRequest>> | undefined;
      try {
        merge = await startRequest(pool, fx, () => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner, autoPostApprovalGuard(true), 'owner'));
        expect(await waitsOnLock(pool, merge.pid)).toBe(true);
        bill = await startRequest(pool, fx, () => createSupplierInvoice(fx.co, {
          trustSourceTax: true, supplierId: fx.supplier, invoiceNumber: `M1-${fx.co.slice(0, 8)}`, invoiceDate: '2026-06-15',
          purchaseOrderId: po.po, taxRate: 15,
          // A line naming the PO's line: the create takes that PO FOR KEY SHARE (assertBillPoLinks) before the bill INSERT's FK.
          items: [{ description: 'Goods', quantity: 1, unitPrice: 20, taxRate: 15, glAccountId: fx.acc.opex, poItemId: po.items[0] }],
        } as never, fx.owner));
        expect(await waitsOnLock(pool, bill.pid)).toBe(true);
      } finally { await hold.release(); }
      const merged = await merge!.done;
      const created = await bill!.done;
      expect(merged.e).toBeUndefined();
      expect(created.e).toBeInstanceOf(BillSupplierDeletedError);
      expect(await deadlocks()).toBe(before);
      expect((await pool.query('SELECT supplier_id::text AS s FROM purchase_orders WHERE id = $1', [po.po])).rows).toEqual([{ s: target }]);
      expect(await liveOn('supplier_invoices', fx.supplier)).toBe(0);
    });
  }, 30_000);
});

describe('H1: supplier payments and a merge of their payee', () => {
  it('createSupplierPayment waits for the paused merge, then is refused before any write', async () => {
    await withFixture('i1699-h1-pay', async (fx, target) => {
      const billId = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'approved' });
      const { merge, release } = await pausedMerge(pool, fx, target);
      let pay: Awaited<ReturnType<typeof startRequest>> | undefined;
      try {
        pay = await startRequest(pool, fx, () => createSupplierPayment(fx.co, {
          supplierId: fx.supplier, paymentDate: '2026-06-20', totalAmount: 115, allocations: [{ invoiceId: billId, amount: 115 }],
        } as never, fx.owner));
        expect(await waitsOnLock(pool, pay.pid)).toBe(true);
      } finally { await release(); }
      expect((await merge.done).e).toBeUndefined();
      const out = await pay!.done;
      expect(out.e).toBeInstanceOf(SupplierPaymentRefusal);
      expect((out.e as Error).message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      expect(await liveOn('supplier_payments', fx.supplier)).toBe(0);
    });
  }, 30_000);

  it('createBatch waits for the paused merge of a payee, then is refused before any write', async () => {
    await withFixture('i1699-h1-batch', async (fx, target) => {
      const billId = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'approved' });
      const { merge, release } = await pausedMerge(pool, fx, target);
      let batch: Awaited<ReturnType<typeof startRequest>> | undefined;
      try {
        batch = await startRequest(pool, fx, () => createBatch(fx.co, {
          batchDate: '2026-06-20', payments: [{ supplierId: fx.supplier, invoiceAllocations: [{ invoiceId: billId, amount: 115 }] }],
        }, fx.owner));
        expect(await waitsOnLock(pool, batch.pid)).toBe(true);
      } finally { await release(); }
      expect((await merge.done).e).toBeUndefined();
      const out = await batch!.done;
      expect(out.e).toBeInstanceOf(SupplierPaymentRefusal);
      expect((out.e as Error).message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_payment_batches WHERE company_id = $1', [fx.co])).rows[0].n)).toBe(0);
    });
  }, 30_000);

  it('a bank-line supplier payment waits for the paused merge of the bill\'s supplier, then is a retryable refusal', async () => {
    await withFixture('i1699-h1-bank', async (fx, target) => {
      const bank = crypto.randomUUID();
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                        VALUES ($1, $2, 'BB-1100', 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, fx.co]);
      await pool.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
                        VALUES ($1, 'Jun 2026', 4, 2027, '2026-06-01', '2026-06-30', 'open')`, [fx.co]);
      const line = String((await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
                        VALUES ($1, $2, '2026-06-20', -115, 'EFT out', 'imported') RETURNING id`, [fx.co, bank])).rows[0].id);
      const billId = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'approved' });
      const { merge, release } = await pausedMerge(pool, fx, target);
      let pay: Awaited<ReturnType<typeof startRequest>> | undefined;
      try {
        pay = await startRequest(pool, fx, () => validateBankSupplierPayment(fx.co, line, [{ invoiceId: billId, amount: 115 }]));
        expect(await waitsOnLock(pool, pay.pid)).toBe(true);
      } finally { await release(); }
      expect((await merge.done).e).toBeUndefined();
      const out = await pay!.done;
      expect(out.e).toBeInstanceOf(SupplierPaymentRefusal);
      expect((out.e as SupplierPaymentRefusal).retryable).toBe(true);
      expect((out.e as Error).message).toContain(SUPPLIER_NOT_LIVE_REFUSAL);
    });
  }, 30_000);

  it('migration 1023: any payment written onto a merged-away supplier is refused; one already there can still be updated', async () => {
    await withFixture('i1699-h1-trigger', async (fx, target) => {
      const old = String((await pool.query(`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, created_by)
                         VALUES ($1, $2, '2026-06-01', 50, 'eft', $3) RETURNING id`, [fx.co, fx.supplier, fx.owner])).rows[0].id);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [fx.supplier, target]);
      const r = await openRequest(pool, fx, fx.owner);
      try {
        await r.client.query('SAVEPOINT a');
        const err = await r.client.query(`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, created_by)
                    VALUES ($1, $2, '2026-06-02', 50, 'eft', $3)`, [fx.co, fx.supplier, fx.owner]).then(() => null, (e: unknown) => e);
        expect(err).toMatchObject({ code: '23503', constraint: 'supplier_payments_supplier_live' });
        await r.client.query('ROLLBACK TO SAVEPOINT a');
        await r.client.query("UPDATE supplier_payments SET description = 'kept' WHERE id = $1", [old]);
        const moveBack = await r.client.query('UPDATE supplier_payments SET supplier_id = $2 WHERE id = $1', [old, fx.supplier]).then(() => null, (e: unknown) => e);
        expect(moveBack).toBeNull(); // unchanged supplier_id: let through
      } finally { await r.rollback(); }
    });
  }, 30_000);
});
