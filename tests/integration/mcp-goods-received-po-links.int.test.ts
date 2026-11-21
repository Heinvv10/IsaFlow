/**
 * The PO link tools keep a bill's goods received note on a PO the bill names (merge-gate finding 3 on #1697, team-lead ruling;
 * docs/design/mcp-goods-received.md "A bill's GRN"), real PostgreSQL, as app_user:
 *   - link_bills_to_purchase_order refuses (note_po_not_named), live and dry run, a call that would leave a bill carrying a note on
 *     PO A naming only PO B; naming A for that bill in the same call goes through;
 *   - unlink_bill_from_purchase_order refuses (live and dry run) unlinking A while B stays named, naming the exit; unlinking B, then
 *     the last PO A, goes through.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-po-links'); }, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

/** PO A with a live note, PO B, and an approved bill of R40 carrying A's note that names no PO yet. */
async function setup(): Promise<{ a: QtyPo; b: QtyPo; bill: string; grnNumber: string }> {
  const a = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const b = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(a, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  const bill = (await seedBill(pool, f, { lines: [40] })).id;
  // An approved bill's content is frozen by its guards; the note is set as the bill create would have set it.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill, r.body.grn_id]);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  return { a, b, bill, grnNumber: String(r.body.grn_number) };
}
const links = async (bill: string) => (await pool.query(
  'SELECT purchase_order_id::text AS po FROM purchase_order_bill_links WHERE supplier_invoice_id = $1 ORDER BY 1', [bill])).rows.map((r) => String(r.po));

describe('link_bills_to_purchase_order and a bill\'s note (gate finding 3)', () => {
  it('a link to PO B alone is refused note_po_not_named, live and dry run, naming PO A; nothing is written', async () => {
    const { a, b, bill, grnNumber } = await setup();
    for (const dry of [true, false]) {
      const r = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill, amount: 40 }], ...(dry ? { dry_run: true } : {}) });
      expect(r.isError, `dry_run ${dry}`).toBe(true);
      expect(r.text).toContain('links[0]');
      expect(r.text).toContain('note_po_not_named');
      expect(r.text).toContain(grnNumber);
      expect(r.text).toContain(`include purchase order ${a.number}`);
    }
    expect(await links(bill)).toEqual([]);
  });

  it('naming PO A for the bill in the same call goes through', async () => {
    const { a, b, bill } = await setup();
    const r = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill, amount: 15 }, { po_id: a.po, bill_id: bill, amount: 25 }] });
    expect(r.isError, r.text).toBe(false);
    expect(await links(bill)).toEqual([a.po, b.po].sort());
  });
});

describe('unlink_bill_from_purchase_order and a bill\'s note (gate finding 3)', () => {
  it('unlinking the note\'s PO while another stays named is refused (live and dry run); unlink the other first, then the last', async () => {
    const { a, b, bill, grnNumber } = await setup();
    expect((await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: bill, amount: 25 }, { po_id: b.po, bill_id: bill, amount: 15 }] })).isError).toBe(false);
    for (const dry of [true, false]) {
      const r = await callTool(pool, f, unlink, { po_id: a.po, bill_id: bill, reason: 'wrong PO', ...(dry ? { dry_run: true } : {}) });
      expect(r.isError, `dry_run ${dry}`).toBe(true);
      expect(r.text).toContain('note_po_not_named');
      expect(r.text).toContain(grnNumber);
      expect(r.text).toContain(`Unlink ${b.number} from the bill first, or cancel the bill`);
    }
    expect(await links(bill)).toEqual([a.po, b.po].sort());
    const other = await callTool(pool, f, unlink, { po_id: b.po, bill_id: bill, reason: 'not this PO' });
    expect(other.isError, other.text).toBe(false);
    const last = await callTool(pool, f, unlink, { po_id: a.po, bill_id: bill, reason: 'the last PO' });
    expect(last.isError, last.text).toBe(false);
    expect(await links(bill)).toEqual([]);
  });
});
