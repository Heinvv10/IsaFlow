/**
 * #1699, the breaker of aad49a02 (M2, L2, L4): writers that put a document on a supplier lock it live first (lockSupplierIfLive),
 * so against the REAL merge of that supplier, paused while it holds the supplier FOR UPDATE (helpers/mergeRace), each waits and is
 * then refused, and nothing lands on the merged-away row. Without the lock each one read the supplier live (the merge had not
 * committed), waited only at its INSERT / UPDATE foreign key, and then wrote onto the soft-deleted supplier.
 *   M2  a PO edit moving a PO to the supplier (PUT /purchase-orders/[id]); the legacy supplier_purchase_orders create.
 *   L2  PO create (POST /purchase-orders), bulk_create_purchase_orders (importPurchaseOrders), supplier returns, a supplier credit
 *       note (createCreditNote's validateSupplierLinks).
 *   L4  the expectation engine (recomputeForSupplier) learns no expectation for a supplier merged away meanwhile.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { dropGrnExtras, dropMaintExtras, seedQtyPo } from './helpers/grnHarness';
import { sagePo } from './helpers/poImportHarness';
import { anotherWaitsOnLock, dropMergeRaceExtras, pausedMerge, settle, startRequest, waitsOnLock } from './helpers/mergeRace';
import { SUPPLIER_NOT_LIVE_REFUSAL } from '@/modules/accounting/services/core/supplierLiveLock';
import { bulkCreatePurchaseOrdersTool } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import type { McpToolContext } from '@/lib/mcp/types';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { ExpectationSupplierNotLiveError, recomputeForSupplier } from '@/modules/accounting/services/capture/expectationEngineService';
import poCreateRoute from '../../pages/api/accounting/purchase-orders';
import poEditRoute from '../../pages/api/accounting/purchase-orders/[id]';
import legacyPoRoute from '../../pages/api/accounting/supplier-purchase-orders';
import supplierReturnsRoute from '../../pages/api/accounting/supplier-returns';

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
const count = async (table: string, supplier: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE supplier_id = $1`, [supplier])).rows[0].n);

/** Runs `write` against the paused merge of fx.supplier into `target`: started, seen waiting, the merge released and committed. */
async function againstMerge<T>(fx: BillFixture, target: string, write: () => Promise<T>, viaRoute = false): Promise<{ v: T | undefined; e: unknown }> {
  const { merge, release } = await pausedMerge(pool, fx, target);
  let done: Promise<{ v: T | undefined; e: unknown }> | undefined;
  try {
    if (viaRoute) {
      done = settle(write());
      expect(await anotherWaitsOnLock(pool, [merge.pid])).toBe(true);
    } else {
      const w = await startRequest(pool, fx, write);
      done = w.done;
      expect(await waitsOnLock(pool, w.pid)).toBe(true);
    }
  } finally { await release(); }
  expect((await merge.done).e).toBeUndefined();
  return done!;
}
type RouteOut = Awaited<ReturnType<typeof callRoute>>;

describe('M2: a PO is never moved onto, or created on, a supplier merged away meanwhile', () => {
  it('PUT /purchase-orders/[id] changing the supplier to the one being merged: waits, then 400; the PO keeps its supplier', async () => {
    await withFixture('i1699-m2-put', async (fx, target) => {
      const other = await seedSupplier(pool, fx, 'i1699 other');
      const po = await seedQtyPo(pool, fx, { status: 'draft', lines: [{ qty: 1, price: 10 }] });
      await pool.query('UPDATE purchase_orders SET supplier_id = $2 WHERE id = $1', [po.po, other]);
      const out = await againstMerge(fx, target, () => callRoute(poEditRoute as never, fx, fx.owner, `/api/accounting/purchase-orders/${po.po}`,
        { supplier_id: fx.supplier }, { method: 'PUT', id: po.po }), true);
      expect((out.v as RouteOut).statusCode, JSON.stringify((out.v as RouteOut).body)).toBe(400);
      expect(JSON.stringify((out.v as RouteOut).body)).toContain(SUPPLIER_NOT_LIVE_REFUSAL);
      expect((await pool.query('SELECT supplier_id::text AS s FROM purchase_orders WHERE id = $1', [po.po])).rows).toEqual([{ s: other }]);
    });
  }, 30_000);

  it('the legacy supplier_purchase_orders create: waits, then 400; nothing on the merged-away supplier', async () => {
    await withFixture('i1699-m2-legacy', async (fx, target) => {
      const out = await againstMerge(fx, target, () => callRoute(legacyPoRoute as never, fx, fx.owner, '/api/accounting/supplier-purchase-orders',
        { supplier_id: fx.supplier, order_date: '2026-06-10', items: [{ description: 'Widget', quantity: 1, unit_price: 10 }] }), true);
      expect((out.v as RouteOut).statusCode, JSON.stringify((out.v as RouteOut).body)).toBe(400);
      expect(await count('supplier_purchase_orders', fx.supplier)).toBe(0);
    });
  }, 30_000);
});

describe('L2: the writers aad49a02 locked', () => {
  it('POST /purchase-orders: waits, then 400; no PO on the merged-away supplier', async () => {
    await withFixture('i1699-l2-po', async (fx, target) => {
      const out = await againstMerge(fx, target, () => callRoute(poCreateRoute as never, fx, fx.owner, '/api/accounting/purchase-orders', {
        supplierId: fx.supplier, orderDate: '2026-06-10', items: [{ description: 'Widget', quantity: 1, unitPrice: 10, taxRate: 15, glAccountId: fx.acc.opex }],
      }), true);
      expect((out.v as RouteOut).statusCode, JSON.stringify((out.v as RouteOut).body)).toBe(400);
      expect(JSON.stringify((out.v as RouteOut).body)).toContain(SUPPLIER_NOT_LIVE_REFUSAL);
      expect(await count('purchase_orders', fx.supplier)).toBe(0);
    });
  }, 30_000);

  it('bulk_create_purchase_orders: waits, then refused naming the merge; nothing written', async () => {
    await withFixture('i1699-l2-import', async (fx, target) => {
      const ctx = { userId: fx.owner, companyId: fx.co, scopes: ['write:invoices', 'read:invoices'], tokenJti: 'jti-i1699', oauthAppId: null, companyRole: 'owner' } as McpToolContext;
      const out = await againstMerge(fx, target, () => bulkCreatePurchaseOrdersTool.handler({ idempotency_key: `i1699-${fx.co}`, purchase_orders: [sagePo(1, fx)] }, ctx));
      expect(out.e).toBeUndefined();
      const res = out.v as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError, res.content[0]!.text).toBe(true);
      expect(res.content[0]!.text).toMatch(/merged into another supplier or deleted/);
      expect(await count('purchase_orders', fx.supplier)).toBe(0);
    });
  }, 30_000);

  it('supplier returns: waits, then 400; no credit note on the merged-away supplier', async () => {
    await withFixture('i1699-l2-return', async (fx, target) => {
      const out = await againstMerge(fx, target, () => callRoute(supplierReturnsRoute as never, fx, fx.owner, '/api/accounting/supplier-returns',
        { supplierId: fx.supplier, amount: 25, reason: 'damaged' }), true);
      expect((out.v as RouteOut).statusCode, JSON.stringify((out.v as RouteOut).body)).toBe(400);
      expect(await count('credit_notes', fx.supplier)).toBe(0);
    });
  }, 30_000);

  it('a supplier credit note (createCreditNote): waits, then refused as not found; none on the merged-away supplier', async () => {
    await withFixture('i1699-l2-cn', async (fx, target) => {
      const out = await againstMerge(fx, target, () => createCreditNote(fx.co, { type: 'supplier', supplierId: fx.supplier, creditDate: '2026-06-20', subtotal: 50, taxRate: 15 } as never, fx.owner));
      expect(out.e).toBeInstanceOf(Error);
      expect((out.e as Error).message).toMatch(/not found/i);
      expect(await count('credit_notes', fx.supplier)).toBe(0);
    });
  }, 30_000);
});

describe('L4: the expectation engine and a merge', () => {
  it('recomputeForSupplier waits for the merge, then refuses; no expectation on the merged-away supplier', async () => {
    await withFixture('i1699-l4', async (fx, target) => {
      const out = await againstMerge(fx, target, () => recomputeForSupplier(fx.co, fx.supplier));
      expect(out.e).toBeInstanceOf(ExpectationSupplierNotLiveError);
      expect(await count('supplier_expectations', fx.supplier)).toBe(0);
    });
  }, 30_000);
});
