/**
 * #1882 fix-verify lows on the draft bill edit's supplier locks (ap/draftBillSupplierLocks), against the REAL merge
 * (helpers/mergeRace), on PostgreSQL as app_user:
 *   L-a  the bill moved meanwhile (a merge committed) to a supplier the edit does not hold, the new one still live: a retryable
 *        "changed meanwhile" refusal (DraftBillChangedError), not "the supplier was merged".
 *   L-b  the edit names the supplier the bill is already on: it is still locked first, so a merge of it in flight is waited for and
 *        the edit then finds it merged away, instead of slipping in after the read.
 *   L-c  a supplier of another company, or none at all, is "Not found", not "merged or deleted".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { dropGrnExtras, dropMaintExtras } from './helpers/grnHarness';
import { dropMergeRaceExtras, pausedMerge, startRequest, waitsOnLock } from './helpers/mergeRace';
import {
  applySupplierInvoiceDraftUpdate, lockAndPlanSupplierInvoiceDraftUpdate, type SupplierInvoiceDraftPatch,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { BillSupplierDeletedError, DraftBillChangedError } from '@/modules/accounting/services/ap/billSupplierLive';

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
const edit = (fx: BillFixture, bill: string, patch: SupplierInvoiceDraftPatch) => async () => {
  const plan = await lockAndPlanSupplierInvoiceDraftUpdate(fx.co, bill, patch);
  await applySupplierInvoiceDraftUpdate(fx.co, plan, fx.owner);
};
/** The edit, started while the merge of fx.supplier into `target` is paused, seen waiting; then the merge released and committed. */
async function againstPausedMerge(fx: BillFixture, target: string, write: () => Promise<void>) {
  const { merge, release } = await pausedMerge(pool, fx, target);
  let w: Awaited<ReturnType<typeof startRequest<void>>> | undefined;
  try {
    w = await startRequest(pool, fx, write);
    expect(await waitsOnLock(pool, w.pid)).toBe(true);
  } finally { await release(); }
  expect((await merge.done).e).toBeUndefined();
  return w!.done;
}
const billRow = async (bill: string) => (await pool.query('SELECT supplier_id::text AS s, notes FROM supplier_invoices WHERE id = $1', [bill])).rows[0];

describe('L-a: the bill moved to the merge survivor while the edit waited, the new supplier still live', () => {
  it('is the retryable "changed meanwhile" refusal; nothing written', async () => {
    await withFixture('i1882-la', async (fx, target) => {
      const third = await seedSupplier(pool, fx, 'i1882 third');
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 20 }]);
      const out = await againstPausedMerge(fx, target, edit(fx, bill, { supplierId: third, notes: 'should not land' }));
      expect(out.e).toBeInstanceOf(DraftBillChangedError);
      expect(await billRow(bill)).toEqual({ s: target, notes: null });
    });
  }, 30_000);
});

describe('L-b: the edit names the supplier the bill is already on, while that supplier is being merged', () => {
  it('waits at the supplier lock, then finds it merged away; the bill moved with the merge, the edit wrote nothing', async () => {
    await withFixture('i1882-lb', async (fx, target) => {
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 20 }]);
      const out = await againstPausedMerge(fx, target, edit(fx, bill, { supplierId: fx.supplier, notes: 'should not land' }));
      expect(out.e).toBeInstanceOf(BillSupplierDeletedError);
      expect(await billRow(bill)).toEqual({ s: target, notes: null });
    });
  }, 30_000);
});

describe('L-c: a supplier that is not this company\'s', () => {
  it('another company\'s supplier, or an id that names none, is Not found', async () => {
    await withFixture('i1882-lc', async (fx) => {
      const other = await seedBillFixture(pool, 'i1882-lc-other');
      try {
        const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 20 }]);
        for (const supplierId of [other.supplier, crypto.randomUUID()]) {
          const r = await openRequest(pool, fx, fx.owner);
          try {
            const err = await r.run(edit(fx, bill, { supplierId })).then(() => null, (e: unknown) => e);
            expect((err as Error | null)?.message, supplierId).toBe('Not found');
          } finally { await r.rollback(); }
        }
      } finally { await dropBillFixture(pool, other); }
    });
  }, 30_000);
});

describe('fix-verify L1: a bill that is not this company\'s (or none) is Not found before any supplier is locked', () => {
  it('answers at once, even while the named supplier is held by someone else', async () => {
    await withFixture('i1882-l1-bill', async (fx, target) => {
      const other = await seedBillFixture(pool, 'i1882-l1-bill-other');
      const hold = await pool.connect();
      try {
        const foreignBill = await makeBill(pool, other, [{ acct: other.acc.opex, amount: 20 }]);
        await hold.query('BEGIN');
        await hold.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [target]);
        for (const bill of [foreignBill, crypto.randomUUID()]) {
          const r = await openRequest(pool, fx, fx.owner);
          const started = Date.now();
          try {
            const err = await r.run(edit(fx, bill, { supplierId: target })).then(() => null, (e: unknown) => e);
            expect((err as Error | null)?.message, bill).toBe('Not found');
            expect(Date.now() - started).toBeLessThan(2000); // never waited on the held supplier (its budget is 5 s)
          } finally { await r.rollback(); }
        }
      } finally { await hold.query('ROLLBACK'); hold.release(); await dropBillFixture(pool, other); }
    });
  }, 30_000);
});

