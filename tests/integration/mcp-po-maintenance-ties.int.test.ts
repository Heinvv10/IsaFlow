/**
 * Which bills tie a purchase order, and the ONE exit (docs/design/mcp-po-maintenance.md, round 5), real PostgreSQL, as app_user:
 *   - for each tie kind the PO maintenance tools refuse "unlink it first (unlink_bill_from_purchase_order)" and unlink then frees the
 *     PO, end to end: a link row; a line-only reference (incl. a R0 line); a header-only reference; a draft bill's line; a cancelled
 *     bill's line; a legacy cross-supplier line;
 *   - unlink with nothing to clear still refuses "not linked"; it clears the link, the lines AND the header together, audits what it
 *     cleared, and writes nothing to the ledger;
 *   - set_purchase_order_status uses the same wording; a header the link tool could not link is no tie;
 *   - another company's bill naming our PO is not a tie (checked as the superuser so row security cannot mask it);
 *   - the REST draft edit answers a PO held by another request with 503 + Retry-After.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import detailRoute from '../../pages/api/accounting/supplier-invoices-detail';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { glCount } from './helpers/poMaintHarness';
import { seedBill, seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';
import { auditOf, callTool, dropMaintExtras, poRow, seedQtyPo } from './helpers/poMaintHarness';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { getSupplierInvoiceTool as getBill } from '@/lib/mcp/tools/supplierInvoices';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { als } from '@/lib/als';
import { readPoTies } from '@/modules/accounting/services/ap/purchaseOrderTies';

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
const NEW_LINE = { description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: '' };
const refs = async (bill: string, po: string) => ({
  links: Number((await pool.query('SELECT count(*) AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1 AND purchase_order_id = $2', [bill, po])).rows[0].n),
  lines: Number((await pool.query('SELECT count(*) AS n FROM supplier_invoice_items sii JOIN po_items pi ON pi.id = sii.po_item_id WHERE sii.supplier_invoice_id = $1 AND pi.purchase_order_id = $2', [bill, po])).rows[0].n),
  header: (await pool.query('SELECT purchase_order_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].purchase_order_id === po,
});

/** Each way a bill can tie a PO. `make` builds it on an approved PO and returns the bill. */
const KINDS: Array<[string, (po: { po: string; items: string[] }) => Promise<string>]> = [
  ['a link row', async (po) => {
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })).isError).toBe(false);
    return bill.id;
  }],
  ['a line-only reference (no link row)', async (po) => {
    const bill = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], bill.lines[0]]);
    return bill.id;
  }],
  ['a R0 line naming a PO line (planBillLinks gives it no link)', async (po) => {
    const bill = await seedRawBill(pool, f, { items: [{ total: 0, poItem: po.items[0] }], subtotal: 0, total: 0 });
    return bill.id;
  }],
  ['a header-only reference by an approved same-supplier bill', async (po) => {
    const bill = await seedBill(pool, f, { lines: [100] });
    await header(bill.id, po.po);
    return bill.id;
  }],
  ["a draft bill's line", async (po) => {
    const bill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], bill.lines[0]]);
    return bill.id;
  }],
  ["a cancelled bill's line", async (po) => {
    const bill = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], bill.lines[0]]);
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill.id]);
    return bill.id;
  }],
  ["a legacy cross-supplier bill's line", async (po) => {
    const bill = await seedBill(pool, f, { lines: [100], supplier: await seedSupplier(pool, f, 'Legacy supplier') });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], bill.lines[0]]);
    return bill.id;
  }],
];

/** Per kind: how get_purchase_order lists it, and what unlink reports clearing (link removed, lines cleared, header cleared). */
const EXPECT: Record<string, { tie: string; linkRemoved: boolean; lines: number; header: boolean }> = {
  'a link row': { tie: 'link', linkRemoved: true, lines: 0, header: true },
  'a line-only reference (no link row)': { tie: 'line', linkRemoved: false, lines: 1, header: false },
  'a R0 line naming a PO line (planBillLinks gives it no link)': { tie: 'line', linkRemoved: false, lines: 1, header: false },
  'a header-only reference by an approved same-supplier bill': { tie: 'header', linkRemoved: false, lines: 0, header: true },
  "a draft bill's line": { tie: 'line', linkRemoved: false, lines: 1, header: false },
  "a cancelled bill's line": { tie: 'line', linkRemoved: false, lines: 1, header: false },
  "a legacy cross-supplier bill's line": { tie: 'line', linkRemoved: false, lines: 1, header: false },
};

describe('every tie kind: the refusal names unlink, and unlink frees the PO', () => {
  it.each(KINDS)('%s', async (name, make) => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await make(po);
    const want = EXPECT[name]!;
    const invoiceNumber = String((await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [bill])).rows[0].invoice_number);
    // The bill is NAMED in the refusal (number, id, kind) and listed by get_purchase_order with its tie kind.
    const shown = await callTool(pool, f, getPo, { po_id: po.po });
    expect((shown.body.bills as Array<Record<string, unknown>>).filter((x) => x.bill_id === bill)).toEqual([expect.objectContaining({ tie: want.tie, deleted: false })]);
    expect(shown.body.bills_total).toBe(1);
    const gl = await glCount(pool, f);
    const status = (await poRow(pool, po.po)).status;
    for (const [label, args] of [['update', { notes: 'x' }], ['update lines', { lines: [{ ...NEW_LINE, gl_account_id: f.acc.opex }] }]] as const) {
      const r = await callTool(pool, f, update, { po_id: po.po, ...args });
      expect(r.isError, label).toBe(true);
      expect(r.text, label).toContain('unlink it first (unlink_bill_from_purchase_order)');
      expect(r.text, label).toContain(`${invoiceNumber} (id ${bill}, ${want.tie})`);
    }
    expect((await callTool(pool, f, cancel, { po_id: po.po, reason: 'x' })).text).toContain('unlink it first (unlink_bill_from_purchase_order)');
    expect((await poRow(pool, po.po)).status).toBe(status);

    const dry = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill, reason: 'free it', dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry).toMatchObject({ wroteNothing: true });
    expect(await refs(bill, po.po)).not.toEqual({ links: 0, lines: 0, header: false });
    const done = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill, reason: 'free it' });
    expect(done.isError, done.text).toBe(false);
    expect(await refs(bill, po.po)).toEqual({ links: 0, lines: 0, header: false });
    expect(await glCount(pool, f)).toEqual(gl);
    const meta = (await auditOf(pool, f, po.po)).at(-1)!.changes.metadata!;
    expect(meta).toMatchObject({
      bill_id: bill, reason: 'free it', source: 'mcp:unlink_bill_from_purchase_order', link_removed: String(want.linkRemoved),
      lines_cleared: String(want.lines), header_cleared: String(want.header),
    });
    // ...and one audit row on the BILL itself, naming what was cleared on it.
    const billAudit = (await pool.query(
      `SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'supplier_invoice' AND entity_id = $2 AND changes->'metadata' ? 'unlinked_from_po'`,
      [f.co, bill])).rows;
    expect(billAudit).toHaveLength(1);
    expect(billAudit[0].user_id).toBe(f.owner);
    expect(billAudit[0].changes.metadata).toMatchObject({
      purchase_order_id: po.po, link_removed: String(want.linkRemoved), lines_cleared: String(want.lines), header_cleared: String(want.header),
      reason: 'free it', source: 'mcp:unlink_bill_from_purchase_order',
    });
    expect((await callTool(pool, f, update, { po_id: po.po, lines: [{ ...NEW_LINE, gl_account_id: f.acc.opex }] })).isError).toBe(false);
  });

  it('what unlink reports: a header-only reference clears the header, a line-only reference clears the line, a link row reports its amount', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const hb = await seedBill(pool, f, { lines: [100] });
    await header(hb.id, po.po);
    const h = await callTool(pool, f, unlink, { po_id: po.po, bill_id: hb.id, reason: 'x' });
    expect(h.body).toMatchObject({ unlinked: true, link_id: null, link_removed: false, header_cleared: true, lines_cleared: 0, amount: 0 });
    const lb = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], lb.lines[0]]);
    const l = await callTool(pool, f, unlink, { po_id: po.po, bill_id: lb.id, reason: 'x' });
    expect(l.body).toMatchObject({ link_id: null, header_cleared: false, lines_cleared: 1 });
    const kb = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: kb.id, lines: [{ po_item_id: po.items[0], bill_line_id: kb.lines[0] }] }] });
    const k = await callTool(pool, f, unlink, { po_id: po.po, bill_id: kb.id, reason: 'x' });
    expect(k.body).toMatchObject({ link_removed: true, header_cleared: true, lines_cleared: 1, amount: 100 });
  });

  it('an unlink with nothing to clear still refuses "not linked"; a header on ANOTHER PO is left alone', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const po2 = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const none = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'x' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('is not linked to purchase order');
    await header(bill.id, po2.po);
    expect((await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'x' })).text).toContain('is not linked');
    expect((await refs(bill.id, po2.po)).header).toBe(true);
  });

  it('clearing a line or header reference never reopens a closed PO (only removing a link can)', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const linked = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: linked.id }], close_when_fully_billed: true })).isError).toBe(false);
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [linked.id]); // closed_under_billed now
    const stray = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po.items[0], stray.lines[0]]);
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: stray.id, reason: 'x' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ reopened_to: null });
    expect((await poRow(pool, po.po)).status).toBe('closed');
  });
});

describe('set_purchase_order_status uses the same wording; a header the link tool could not link is no tie', () => {
  it.each(['approved', 'closed'])('an imported %s PO with a header-only bill: -> draft / cancelled say "unlink it first", and unlink then frees it', async (status) => {
    const po = await seedQtyPo(pool, f, { external: true, status, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await header(bill.id, po.po);
    for (const target of ['draft', 'cancelled']) {
      const r = await set(po.po, target);
      expect(r.isError, target).toBe(true);
      expect(r.text).toContain(`it cannot go to ${target}`);
      expect(r.text).toContain('unlink it first (unlink_bill_from_purchase_order)');
    }
    expect((await poRow(pool, po.po)).status).toBe(status);
    expect((await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'x' })).isError).toBe(false);
    expect((await set(po.po, 'cancelled')).isError).toBe(false);
  });

  it('a draft bill\'s header is no tie: the move is allowed', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await header(bill.id, po.po);
    expect((await set(po.po, 'cancelled')).isError).toBe(false);
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
    expect((await asSuperuser(() => readPoTies(f.co, po.po, 10))).rows).toEqual([]);
    const ours = await seedBill(pool, f, { lines: [100] });
    await header(ours.id, po.po);
    expect((await asSuperuser(() => readPoTies(f.co, po.po, 10))).rows.map((r) => r.tie)).toEqual(['header']);
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
