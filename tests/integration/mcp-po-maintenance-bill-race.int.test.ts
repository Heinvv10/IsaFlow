/**
 * update_purchase_order x bill create (review M1, docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user. A bill create
 * checked its lines' po_item_id (unlocked), then inserted the bill, and only then took the PO `FOR KEY SHARE` (recordBillLinks); an
 * update of the APPROVED PO (FOR UPDATE, replaces the po_items rows) between the two left the bill line naming a deleted PO line.
 *   - window opened deterministically: the update runs straight after the create's first read of po_items; the create must then be
 *     refused (its PO line is gone), never leave a line naming a deleted one;
 *   - lock: an update started right after the create took its PO lock waits (a lock wait is seen) until the bill commits, then is
 *     refused because the bill's line names one of the PO's lines (the re-check alone, with no lock, would let the update through).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hooks = vi.hoisted(() => ({
  afterPoItemsRead: null as null | (() => Promise<void>), afterPoLock: null as null | (() => Promise<void>), fired: 0,
}));
// Every statement passes through to the real database untouched (the wrapper must stay lazy: sql returns a LazyQuery); after the
// first read of po_items (assertBillPoLinks' check) the armed hook runs once.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
  const wrapper = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterPoItemsRead;
    if (hook && /^\s*SELECT/.test(text) && text.includes('FROM po_items pi JOIN purchase_orders')) {
      hooks.afterPoItemsRead = null;
      return (async () => { const rows = await realSql(strings, ...values); hooks.fired++; await hook(); return rows; })();
    }
    return realSql(strings, ...values);
  };
  // The create's own transaction (`tx`): after the statement that takes the POs FOR KEY SHARE, the second armed hook runs once.
  const realWithTransaction = real.withTransaction as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  const withTransaction = (fn: (tx: unknown) => Promise<unknown>) => realWithTransaction((tx) => {
    const realTx = tx as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
    const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const hook = hooks.afterPoLock;
      if (hook && strings.join('?').includes('FOR KEY SHARE OF po')) {
        hooks.afterPoLock = null;
        return (async () => { const rows = await realTx(strings, ...values); hooks.fired++; await hook(); return rows; })();
      }
      return realTx(strings, ...values);
    };
    return fn(Object.assign(wrapped, realTx));
  });
  return { ...real, sql: Object.assign(wrapper, realSql), withTransaction };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo } from './helpers/poBillLinkHarness';
import { callTool, dropMaintExtras, poLines } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { refreshAppBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-bill-race'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

let n = 0;
const billFor = (poItem: string) => ({
  invoiceNumber: `RACE-${++n}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15',
  items: [{ description: 'Billed', quantity: 1, unitPrice: 100, taxRate: 0, glAccountId: f.acc.opex, poItemId: poItem }],
});
const newLines = [{ description: 'Replaced', quantity: 1, unit_price: 90, tax_rate: 0, gl_account_id: '' }];
const orphans = async () => Number((await pool.query(
  `SELECT count(*) AS n FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
    WHERE si.company_id = $1 AND sii.po_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM po_items pi WHERE pi.id = sii.po_item_id)`, [f.co])).rows[0].n);

describe('update_purchase_order x bill create', () => {
  it('an update that lands between the create\'s check and its insert refuses the create: no bill line names a deleted PO line', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    hooks.fired = 0;
    hooks.afterPoItemsRead = async () => {
      const r = await callTool(pool, f, update, { po_id: po.po, lines: [{ ...newLines[0]!, gl_account_id: f.acc.opex }] });
      expect(r.isError, r.text).toBe(false);
    };
    const req = await openRequest(pool, f, f.owner);
    let refusal: unknown;
    try {
      await req.run(() => createSupplierInvoice(f.co, billFor(po.items[0]!), f.owner));
      await req.commit();
    } catch (e) { refusal = e; await req.rollback(); }
    expect(hooks.fired, 'the hook ran, so the window was opened').toBe(1);
    expect(refusal, 'the create is refused').toMatchObject({ code: 'SUPPLIER_INVOICE_PO_LINK_REFUSED' });
    expect(await orphans()).toBe(0);
    expect((await poLines(pool, po.po)).map((l) => l.description)).toEqual(['Replaced']);
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number LIKE $2', [f.co, 'RACE-%'])).rows[0].n)).toBe(0);
  });

  it('the create\'s lock is real: an update started right after the create locked its PO waits for the bill, then is refused because the bill\'s line names a PO line', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    hooks.fired = 0;
    let finished = false;
    let upd: ReturnType<typeof callTool> | undefined;
    let waited = false;
    hooks.afterPoLock = async () => {
      upd = callTool(pool, f, update, { po_id: po.po, lines: [{ ...newLines[0]!, gl_account_id: f.acc.opex }] });
      void upd.finally(() => { finished = true; });
      for (let i = 0; i < 60 && !waited && !finished; i++) {
        await new Promise((r) => setTimeout(r, 50));
        waited = Number((await pool.query(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM purchase_orders%FOR UPDATE%'`)).rows[0].n) > 0;
      }
    };
    const req = await openRequest(pool, f, f.owner);
    await req.run(() => createSupplierInvoice(f.co, billFor(po.items[0]!), f.owner));
    await req.commit();
    expect(hooks.fired, 'the hook ran after the create locked its PO').toBe(1);
    expect(waited, 'the update was waiting on the PO row the bill holds').toBe(true);
    const r = await upd!;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Bills are linked');
    expect(await orphans()).toBe(0);
    expect((await poLines(pool, po.po)).map((l) => l.description)).toEqual(['PO line 0']);
  }, 30_000);

  it('a PO held FOR UPDATE by another request ends the create in the typed retryable timeout (5 s), nothing written', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const holder = await pool.connect();
    const number = `RACE-LOCK-${Date.now()}`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
      const req = await openRequest(pool, f, f.owner);
      const started = Date.now();
      let err: unknown;
      try { await req.run(() => createSupplierInvoice(f.co, { ...billFor(po.items[0]!), invoiceNumber: number }, f.owner)); await req.commit(); } catch (e) { err = e; await req.rollback(); }
      expect(err).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
      expect(Date.now() - started, 'bounded, not unbounded').toBeLessThan(15_000);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [f.co, number])).rows[0].n)).toBe(0);
    expect(await orphans()).toBe(0);
  }, 30_000);

  it('a HEADER-only bill (no PO line named) and a draft edit take the same bounded wait: the PO held FOR UPDATE ends both in the typed timeout, nothing written', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const header = (n: string) => ({
      invoiceNumber: n, supplierId: f.supplier, invoiceDate: '2026-06-15', purchaseOrderId: po.po,
      items: [{ description: 'Header only', quantity: 1, unitPrice: 100, taxRate: 0, glAccountId: f.acc.opex }],
    });
    // A draft bill that already names the PO in its header, for the edit leg (created before the PO is held).
    const draftReq = await openRequest(pool, f, f.owner);
    const draft = await draftReq.run(() => createSupplierInvoice(f.co, header(`HDR-DRAFT-${Date.now()}`), f.owner));
    await draftReq.commit();
    await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [draft.id]);
    const holder = await pool.connect();
    const number = `HDR-LOCK-${Date.now()}`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
      const started = Date.now();
      const create = await openRequest(pool, f, f.owner);
      let createErr: unknown;
      try { await create.run(() => createSupplierInvoice(f.co, header(number), f.owner)); await create.commit(); } catch (e) { createErr = e; await create.rollback(); }
      expect(createErr).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
      const edit = await openRequest(pool, f, f.owner);
      let editErr: unknown;
      try { await edit.run(() => refreshAppBillLinks(f.co, draft.id, f.owner)); await edit.commit(); } catch (e) { editErr = e; await edit.rollback(); }
      expect(editErr).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
      expect(Date.now() - started, 'two bounded waits, not unbounded').toBeLessThan(25_000);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [f.co, number])).rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM purchase_order_bill_links WHERE purchase_order_id = $1', [po.po])).rows[0].n)).toBe(0);
  }, 40_000);
});
