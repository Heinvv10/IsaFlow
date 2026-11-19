/**
 * Ties, round 6 (docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user:
 *   - get_purchase_order lists a link on a DELETED bill (flagged), caps its bill list with the total, and the refusal names ten bills and
 *     counts the rest; the bill reads expose the header purchase_order_id;
 *   - unlink warns about the budget only when clearing raises committed spend: an approved bill's non-zero line, never a draft /
 *     cancelled / deleted / R0 bill's cleanup or a header;
 *   - after clearing, the bill's stored three-way state is re-judged or reset, never left stale.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill, seedPo, seedRawBill } from './helpers/poBillLinkHarness';
import { auditOf, callTool, dropMaintExtras } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { getSupplierInvoiceTool as getBill, listSupplierInvoicesTool as listBills } from '@/lib/mcp/tools/supplierInvoices';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-ties-more'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const nameLine = (bill: { lines: string[] }, poItem: string) => pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [poItem, bill.lines[0]]);
const NEW_LINE = () => ({ description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: f.acc.opex });

describe('listing and naming the bills that tie a PO', () => {
  it('a link on a deleted bill is listed (flagged) and named; the bill list is capped with the total, the refusal names ten and counts the rest', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const gone = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: gone.id }] })).isError).toBe(false);
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [gone.id]);
    const shown = await callTool(pool, f, getPo, { po_id: po.po });
    expect(shown.body.bills).toEqual([expect.objectContaining({ bill_id: gone.id, tie: 'link', deleted: true, counts_as_billed: false })]);
    const refused = await callTool(pool, f, update, { po_id: po.po, notes: 'x' });
    expect(refused.text).toContain(`(id ${gone.id}, link, deleted)`);

    const many = await seedPo(pool, f, { lines: [100] });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) { const b = await seedBill(pool, f, { lines: [10] }); await nameLine(b, many.items[0]!); ids.push(b.id); }
    const list = await callTool(pool, f, getPo, { po_id: many.po });
    expect(list.body.bills_total).toBe(12);
    expect((list.body.bills as unknown[]).length).toBe(12);
    const r = await callTool(pool, f, update, { po_id: many.po, notes: 'x' });
    expect(r.text).toContain('; and 2 more]');
    expect(ids.filter((id) => r.text.includes(`(id ${id},`))).toHaveLength(10);
  });

  it('get_supplier_invoice and list_supplier_invoices expose the header purchase_order_id, null when it names none', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const named = await seedBill(pool, f, { lines: [100] });
    const plain = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [po.po, named.id]);
    expect((await callTool(pool, f, getBill, { invoice_id: named.id })).body).toMatchObject({ purchase_order_id: po.po, purchase_order_ids: [] });
    expect((await callTool(pool, f, getBill, { invoice_id: plain.id })).body).toMatchObject({ purchase_order_id: null });
    const l = await callTool(pool, f, listBills, { limit: 200 });
    const rows = (l.body.invoices ?? l.body.items ?? l.body.data) as Array<{ id: string; purchase_order_id: string | null }>;
    expect(rows.find((x) => x.id === named.id)?.purchase_order_id).toBe(po.po);
  });
});

describe('the budget warning on an unlink', () => {
  // A PO over its monthly budget on opex FT (1 000): any unlink that makes it commit more would warn.
  const overPo = () => seedPo(pool, f, { lines: [1500], acct: f.acc.opex, cc1: f.cc.FT });

  it('an approved bill\'s non-zero line reference raises committed: warned; a header, or a draft / cancelled / deleted / R0 bill\'s cleanup, changes no figure: no warning', async () => {
    const po = await overPo();
    const approved = await seedBill(pool, f, { lines: [100] });
    await nameLine(approved, po.items[0]!);
    const raised = await callTool(pool, f, unlink, { po_id: po.po, bill_id: approved.id, reason: 'x' });
    expect(raised.isError, raised.text).toBe(false);
    expect(String(raised.body.budget_warning)).toContain('over budget');
    expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata).toMatchObject({ raised_committed: 'true' });

    const quiet: Array<[string, () => Promise<string>]> = [
      ['a draft bill', async () => { const b = await seedBill(pool, f, { lines: [100], status: 'draft' }); await nameLine(b, po.items[0]!); return b.id; }],
      ['a cancelled bill', async () => { const b = await seedBill(pool, f, { lines: [100] }); await nameLine(b, po.items[0]!); await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [b.id]); return b.id; }],
      ['a deleted bill', async () => { const b = await seedBill(pool, f, { lines: [100] }); await nameLine(b, po.items[0]!); await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [b.id]); return b.id; }],
      ['an approved R0 line', async () => { const b = await seedRawBill(pool, f, { items: [{ total: 0, poItem: po.items[0] }], subtotal: 0, total: 0 }); return b.id; }],
      ['a header only', async () => { const b = await seedBill(pool, f, { lines: [100] }); await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [po.po, b.id]); return b.id; }],
    ];
    for (const [label, make] of quiet) {
      const bill = await make();
      const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill, reason: 'cleanup' });
      expect(r.isError, `${label}: ${r.text}`).toBe(false);
      expect(r.body.budget_warning, label).toBeNull();
      expect(r.body.budget_warnings, label).toEqual([]);
      expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata, label).toMatchObject({ raised_committed: 'false' });
    }
  });
});

describe('the bill\'s stored three-way state after a clear', () => {
  const stale = async (bill: { id: string; lines: string[] }) => {
    await pool.query("UPDATE supplier_invoices SET match_status = 'fully_matched' WHERE id = $1", [bill.id]);
    await pool.query("UPDATE supplier_invoice_items SET line_match_status = 'fully_matched', qty_variance_pct = 1, price_variance_pct = 1, match_computed_at = NOW() WHERE supplier_invoice_id = $1", [bill.id]);
  };
  const state = async (bill: string) => ({
    bill: String((await pool.query('SELECT match_status FROM supplier_invoices WHERE id = $1', [bill])).rows[0].match_status),
    lines: (await pool.query('SELECT line_match_status, qty_variance_pct, match_computed_at FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY id', [bill])).rows,
  });

  it('a bill left naming no PO is reset to unmatched, lines included', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await nameLine(bill, po.items[0]!);
    await stale(bill);
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'x' });
    expect(r.isError, r.text).toBe(false);
    const s = await state(bill.id);
    expect(s.bill).toBe('unmatched');
    expect(s.lines).toEqual([{ line_match_status: 'unmatched', qty_variance_pct: null, match_computed_at: null }]);
    const meta = (await auditOf(pool, f, po.po)).at(-1)!.changes.metadata!;
    expect(meta.match_state).toBe('reset');
  });

  it('a bill that still names another PO is re-judged by the three-way recompute: the cleared line unmatched, the match no longer the stale one', async () => {
    const po1 = await seedPo(pool, f, { lines: [100] });
    const po2 = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100, 200] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po1.items[0], bill.lines[0]]);
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [po2.items[0], bill.lines[1]]);
    await stale(bill);
    const r = await callTool(pool, f, unlink, { po_id: po1.po, bill_id: bill.id, reason: 'x' });
    expect(r.isError, r.text).toBe(false);
    const s = await state(bill.id);
    expect(s.lines.map((l) => l.line_match_status)).toContain('unmatched');
    expect(s.bill).not.toBe('fully_matched');
    expect((await auditOf(pool, f, po1.po)).at(-1)!.changes.metadata!.match_state).toBe('recomputed');
  });
});
