/**
 * Which bills tie a purchase order (poBillTie; review round 4 of docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user:
 *   - set_purchase_order_status -> draft / cancelled says "link it first" for a header-only tie (it said "unlink them first", which
 *     unlink answers "not linked"); a tie the link tool could not make is no tie;
 *   - a CANCELLED bill's line is no tie (the link tool and the backfill skip cancelled bills: nothing could clear it);
 *   - the way out when the default link amount would be 0: link with an explicit 0.01, then unlink, then the PO is free;
 *   - another company's bill naming our PO (header and line) is not a tie, checked as the superuser so row security cannot mask it;
 *   - the REST draft edit answers a PO held by another request with 503 + Retry-After (not "400 Failed to update"), and nothing changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import detailRoute from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill, seedPo } from './helpers/poBillLinkHarness';
import { callTool, dropMaintExtras, poRow, seedQtyPo } from './helpers/poMaintHarness';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { als } from '@/lib/als';
import { poBillTie } from '@/modules/accounting/services/ap/purchaseOrderMaintenanceGuards';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-ties');
  other = await seedBillFixture(pool, 'po-maint-ties-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => { try { for (const x of [f, other]) { await dropMaintExtras(pool, x); await dropBillFixture(pool, x); } } finally { await pool.end(); } }, 60_000);

const header = (bill: string, po: string) => pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [po, bill]);
const set = (po: string, status: string) => callTool(pool, f, setStatus, { po_id: po, status, reason: 'ties' });

describe('set_purchase_order_status and a header-only tie', () => {
  it.each(['approved', 'closed'])('an imported %s PO with an approved same-supplier header-only bill: -> draft / cancelled say "link it first", and nothing changes', async (status) => {
    const po = await seedQtyPo(pool, f, { external: true, status, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await header(bill.id, po.po);
    for (const target of ['draft', 'cancelled']) {
      const r = await set(po.po, target);
      expect(r.isError, target).toBe(true);
      expect(r.text).toContain(`it cannot go to ${target}`);
      expect(r.text).toContain('link it first (link_bills_to_purchase_order');
      expect(r.text).not.toContain('unlink them first');
    }
    expect((await poRow(pool, po.po)).status).toBe(status);
  });

  it('a header the link tool could not link (a draft bill) is no tie: the move is allowed', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await header(bill.id, po.po);
    expect((await set(po.po, 'cancelled')).isError).toBe(false);
  });

  it('a real link still says "unlink them first"', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })).isError).toBe(false);
    expect((await set(po.po, 'draft')).text).toContain('unlink them first (unlink_bill_from_purchase_order)');
  });
});

describe('a cancelled bill\'s line is no tie', () => {
  it('update and cancel go through; an approved bill\'s line still ties', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], bill.lines[0]]);
    const line = { description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: f.acc.opex };
    expect((await callTool(pool, f, update, { po_id: po.po, lines: [line] })).text).toContain('Bills are linked');
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill.id]);
    expect((await callTool(pool, f, update, { po_id: po.po, lines: [line] })).isError).toBe(false);
    const po2 = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const bill2 = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po2.items[0], bill2.lines[0]]);
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill2.id]);
    expect((await callTool(pool, f, cancel, { po_id: po2.po, reason: 'free' })).isError).toBe(false);
  });
});

describe('the way out when the default link amount is 0', () => {
  it('a bill already fully linked elsewhere: link with an explicit 0.01, unlink, and the PO is free', async () => {
    const po1 = await seedPo(pool, f, { lines: [100] });
    const po2 = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po1.po, bill_id: bill.id }] })).isError).toBe(false);
    await header(bill.id, po2.po); // the app named the second PO in the header while it was only submitted
    const line = { description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: f.acc.opex };
    const refused = await callTool(pool, f, update, { po_id: po2.po, lines: [line] });
    expect(refused.text).toContain('link it first');
    expect(refused.text).toContain('explicit amount of 0.01');
    expect(refused.text).not.toContain("clear the bill's purchase order");
    const plain = await callTool(pool, f, link, { links: [{ po_id: po2.po, bill_id: bill.id }] });
    expect(plain.isError, 'the default amount would be 0').toBe(true);
    const escape = await callTool(pool, f, link, { links: [{ po_id: po2.po, bill_id: bill.id, amount: 0.01 }] });
    expect(escape.isError, escape.text).toBe(false);
    expect((await callTool(pool, f, update, { po_id: po2.po, notes: 'x' })).text).toContain('Bills are linked');
    expect((await callTool(pool, f, unlink, { po_id: po2.po, bill_id: bill.id, reason: 'not billing this order' })).isError).toBe(false);
    expect((await callTool(pool, f, update, { po_id: po2.po, lines: [line] })).isError).toBe(false);
  });
});

describe('another company\'s bill is not a tie (checked as the superuser: row security cannot mask a missing company filter)', () => {
  async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await als.run({ client, companyId: f.co, userId: f.owner, claims: { sub: f.owner } } as never, fn);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }

  it('their approved bill naming our PO in its header, or on a line, with our supplier id, ties nothing; ours does', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const theirs = await seedBill(pool, other, { lines: [100] });
    // As qualifying as it can be but for the company: approved, our PO's supplier, naming our PO.
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1, supplier_id = $2 WHERE id = $3', [po.po, f.supplier, theirs.id]);
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], theirs.lines[0]]);
    expect(await asSuperuser(() => poBillTie(f.co, po.po))).toBeNull();
    const ours = await seedBill(pool, f, { lines: [100] });
    await header(ours.id, po.po);
    expect(await asSuperuser(() => poBillTie(f.co, po.po))).toBe('header');
  });
});

describe('REST draft edit and a PO held by another request', () => {
  it('answers 503 + Retry-After with the typed code, changes nothing, and succeeds once the PO is free', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const draft = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await header(draft.id, po.po);
    const token = await new SignJWT({ sub: f.owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const put = async (notes: string) => {
      const req = request({ 'sb-access-token': token, active_company_id: f.co }, 'PUT');
      req.url = '/api/accounting/supplier-invoices-detail';
      req.body = { id: draft.id, notes };
      const result = response();
      await (detailRoute as unknown as (a: never, b: never) => Promise<unknown>)(req as never, result.res as never);
      return result;
    };
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
      const held = await put('while held');
      expect(held.state.statusCode).toBe(503);
      expect(held.headers.get('retry-after')).toBeTruthy();
      expect(JSON.stringify(held.state.body)).toContain('PURCHASE_ORDER_LOCK_TIMEOUT');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect((await pool.query('SELECT notes FROM supplier_invoices WHERE id = $1', [draft.id])).rows[0].notes).toBeNull();
    const free = await put('after');
    expect(free.state.statusCode, JSON.stringify(free.state.body)).toBe(200);
    expect((await pool.query('SELECT notes FROM supplier_invoices WHERE id = $1', [draft.id])).rows[0].notes).toBe('after');
  }, 30_000);
});
