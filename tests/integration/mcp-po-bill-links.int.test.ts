/**
 * link_bills_to_purchase_order (design docs/design/mcp-po-bill-links.md, migration 1006), real PostgreSQL, every call as
 * app_user (poImportHarness). Cross-company refusals are enforced twice: by the tool's own company-scoped reads and by RLS.
 *   - 100 links on APPROVED bills (five really approved, so they carry journals) write no journal row and leave every bill's
 *     status, totals and amount_paid alone;
 *   - close_when_fully_billed (owner / admin only, R1) closes the PO that the call leaves fully billed; nothing closes it without;
 *   - cross-supplier, cross-company, already-linked, draft / cancelled / soft-deleted bill and draft-PO rows are refused, each listed;
 *   - external_ref: the same pair again is already_existed; a ref-less app link ADOPTS the reference; a different amount or
 *     lines are refused payload_differs; a reference on another pair is refused;
 *   - dry_run writes nothing, leaves the key free and refuses what the live call refuses.
 * The unlink, the budget and the reads are in mcp-po-bill-links-flows.int.test.ts.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, type Json } from './helpers/poImportHarness';
import {
  approveBill, billHeader, ledgerSnapshot, lineLinks, linkRows, poStatus, seedBill, seedPo, seedSupplier,
} from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { findByExternalRefTool as find } from '@/lib/mcp/tools/externalRef';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links');
  other = await seedBillFixture(pool, 'po-links-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally {
    await pool.end();
  }
}, 60_000);

describe('100 links on approved bills', () => {
  it('write no journal and leave every bill as it was', async () => {
    const pos = [];
    for (let i = 0; i < 100; i++) pos.push(await seedPo(pool, f, { lines: [100 + i], status: i % 4 === 0 ? 'received' : 'approved' }));
    const bills = [];
    for (let i = 0; i < 100; i++) bills.push(await seedBill(pool, f, { lines: [100 + i], status: i < 5 ? 'draft' : 'approved' }));
    // Five bills are APPROVED through the real service: they carry journals.
    for (const b of bills.slice(0, 5)) await approveBill(pool, f, b.id);
    const journalled = await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE company_id = $1 AND gl_journal_entry_id IS NOT NULL', [f.co]);
    expect(journalled.rows[0].n).toBe(5);

    const before = await ledgerSnapshot(pool, f, bills.map((b) => b.id));
    expect(before.entries).toBeGreaterThanOrEqual(5);
    const r = await callTool(pool, f, link, {
      links: pos.map((p, i) => ({ po_number: p.number, bill_id: bills[i]!.id, external_system: 'sage', external_ref: `FD-${i}` })),
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ linked: 100, already_existed: 0 });
    expect((r.body.links as Json[])[7]).toMatchObject({ amount: 107, already_existed: false, lines_linked: 0 });

    const after = await ledgerSnapshot(pool, f, bills.map((b) => b.id));
    expect(after).toEqual(before);
    const rows = await linkRows(pool, f);
    expect(rows).toHaveLength(100);
    expect(rows.every((l) => l.source === 'mcp' && l.created_by === f.owner)).toBe(true);
    expect(await billHeader(pool, bills[3]!.id)).toBe(pos[3]!.po);
    const audits = await pool.query("SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order'", [f.co]);
    expect(audits.rows[0].n).toBe(100);
  }, 180_000);
});

describe('close_when_fully_billed', () => {
  it('leaves a fully billed PO alone without the flag, and closes it with it', async () => {
    const p1 = await seedPo(pool, f, { lines: [100, 200], status: 'partially_received' });
    const b1 = await seedBill(pool, f, { lines: [300] });
    const noFlag = await callTool(pool, f, link, { links: [{ po_id: p1.po, bill_id: b1.id }] });
    expect(noFlag.body.purchase_orders).toEqual([expect.objectContaining({ status: 'partially_received', billed: 300, fully_billed: true, closed_by_this_call: false })]);
    expect(await poStatus(pool, p1.po)).toBe('partially_received');

    const p2 = await seedPo(pool, f, { lines: [100, 200], status: 'partially_received' });
    const half = await seedBill(pool, f, { lines: [100] });
    const rest = await seedBill(pool, f, { lines: [200] });
    const first = await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: half.id }], close_when_fully_billed: true });
    expect(first.body.purchase_orders).toEqual([expect.objectContaining({ status: 'partially_received', billed: 100, fully_billed: false })]);
    const second = await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: rest.id }], close_when_fully_billed: true });
    expect(second.body.purchase_orders).toEqual([expect.objectContaining({ status_before: 'partially_received', status: 'closed', closed_by_this_call: true, fully_billed: true })]);
    expect(await poStatus(pool, p2.po)).toBe('closed');
    // PR #1703 R4-1: the closing is recorded on the PO (closed_by_billing + closed_from_status), never on a link.
    expect((await pool.query('SELECT closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [p2.po])).rows[0])
      .toEqual({ closed_from_status: 'partially_received', closed_by_billing: true });
    expect((await linkRows(pool, f, `l.purchase_order_id = '${p2.po}'`)).map((l) => l.closed_po_from_status)).toEqual([null, null]);
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE entity_id = $1 AND entity_type = 'purchase_order' ORDER BY created_at DESC, id LIMIT 1`, [p2.po]);
    expect(audit.rows[0].changes.fields).toEqual([{ field: 'status', old: 'partially_received', new: 'closed', label: 'Status' }]);
  });

  it('R1: closing is the owner\'s or admin\'s call: a manager with the flag is refused before anything is read, dry run too; without the flag a manager links', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    for (const dry of [false, true]) {
      const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true, dry_run: dry }, { companyRole: 'manager', user: f.manager });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('only an owner or admin may do');
    }
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    const plain = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] }, { companyRole: 'manager', user: f.manager });
    expect(plain.isError, plain.text).toBe(false);
    expect(await poStatus(pool, po.po)).toBe('approved');
    const po2 = await seedPo(pool, f, { lines: [50] });
    const b2 = await seedBill(pool, f, { lines: [50] });
    const admin = await callTool(pool, f, link, { links: [{ po_id: po2.po, bill_id: b2.id }], close_when_fully_billed: true }, { companyRole: 'admin' });
    expect(admin.isError, admin.text).toBe(false);
    expect(await poStatus(pool, po2.po)).toBe('closed');
  });

  it('a closed PO still takes a link and stays closed; a link that does not cover the PO leaves it open', async () => {
    const closed = await seedPo(pool, f, { lines: [80], status: 'closed' });
    const b = await seedBill(pool, f, { lines: [80] });
    const c = await callTool(pool, f, link, { links: [{ po_id: closed.po, bill_id: b.id }], close_when_fully_billed: true });
    expect(c.isError, c.text).toBe(false);
    expect(c.body.purchase_orders).toEqual([expect.objectContaining({ status: 'closed', closed_by_this_call: false, fully_billed: true })]);
    const po = await seedPo(pool, f, { lines: [200] });
    const part = await seedBill(pool, f, { lines: [50] });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: part.id }], close_when_fully_billed: true });
    expect(r.body.purchase_orders).toEqual([expect.objectContaining({ status: 'approved', billed: 50, fully_billed: false })]);
  });
});

describe('refusals: every bad row listed, nothing written', () => {
  it('cross-supplier, cross-company, cancelled bill, draft PO, bad line, already linked', async () => {
    const otherSupplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'Other supplier', true)", [otherSupplier, f.co]);
    const po = await seedPo(pool, f, { lines: [100] });
    const strangers = await seedPo(pool, f, { lines: [100], supplier: otherSupplier });
    const draftPo = await seedPo(pool, f, { lines: [100], status: 'draft' });
    const theirPo = await seedPo(pool, other, { lines: [100] });
    const theirBill = await seedBill(pool, other, { lines: [100] });
    const ok = await seedBill(pool, f, { lines: [100] });
    const cancelled = await seedBill(pool, f, { lines: [100], status: 'cancelled' });
    const draftBill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    const deletedBill = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [deletedBill.id]);
    const taken = await seedBill(pool, f, { lines: [100] });
    const bill2 = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: taken.id }] })).isError).toBe(false);
    const rowsBefore = await linkRows(pool, f);

    const r = await callTool(pool, f, link, {
      links: [
        { po_id: po.po, bill_id: ok.id },                                            // 0 fine
        { po_id: strangers.po, bill_id: ok.id },                                     // 1 cross-supplier
        { po_id: theirPo.po, bill_id: ok.id },                                       // 2 another company's PO
        { po_id: po.po, bill_id: theirBill.id },                                     // 3 another company's bill
        { po_id: po.po, bill_id: cancelled.id },                                     // 4 cancelled bill
        { po_id: draftPo.po, bill_id: bill2.id },                                    // 5 draft PO
        { po_id: po.po, bill_id: taken.id },                                         // 6 already linked
        { po_id: po.po, bill_id: bill2.id, lines: [{ po_item_id: strangers.items[0], bill_line_id: bill2.lines[0] }] }, // 7 PO line of another PO
        { po_id: po.po, bill_id: ok.id },                                            // 8 same pair as 0
        { po_id: po.po, bill_id: draftBill.id },                                     // 9 draft bill (R3)
        { po_id: po.po, bill_id: deletedBill.id },                                   // 10 soft-deleted bill
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('10 of 11 links cannot be made; nothing was linked.');
    for (const reason of [
      'links[1]: bill', 'are of different suppliers', 'links[2]: purchase order not found', 'links[3]: bill not found', 'is cancelled',
      'links[5]: purchase order', 'is draft', 'links[6]: bill', 'is already linked to purchase order', `links[7]: purchase order line ${strangers.items[0]} is not a line of purchase order`,
      'links[8]: the same purchase order and bill as links[0]',
      'links[9]: bill', 'is draft; only an approved, paid or partially paid bill can be linked', 'links[10]: bill not found',
    ]) expect(r.text).toContain(reason);
    expect(r.text).not.toContain('links[0]:');
    expect(await linkRows(pool, f)).toEqual(rowsBefore);
    expect(await billHeader(pool, ok.id)).toBeNull();
  });

  it('a bill line already naming another PO line, a line named twice, and an amount past the subtotal are refused', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [100] });
    // PR #1703 (BRK-A): an explicit amount beside lines must be the lines' posted amount, so the R40 is now a R40 line of a R100 bill.
    const bill = await seedBill(pool, f, { lines: [40, 60] });
    expect((await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: bill.id, amount: 40, lines: [{ po_item_id: a.items[0], bill_line_id: bill.lines[0] }] }] })).isError).toBe(false);
    const again = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id, lines: [{ po_item_id: b.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(again.text).toContain('already names another purchase order line');
    const past = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id, amount: 60.02 }] });
    expect(past.text).toContain('would pass it');
    const rest = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id }] });
    expect(rest.isError, rest.text).toBe(false);
    expect(rest.body.links).toEqual([expect.objectContaining({ amount: 60 })]);
  });
});

describe('idempotency on external_ref', () => {
  it('the same pair under the same reference is already_existed and leaves the key free; a reference on another pair is refused', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100] });
    const b1 = await seedBill(pool, f, { lines: [100] });
    const b2 = await seedBill(pool, f, { lines: [100] });
    const first = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id, external_system: 'Sage', external_ref: 4711 }] });
    expect(first.body).toMatchObject({ linked: 1 });
    expect(first.wroteNothing).toBe(false);
    const rerun = await callTool(pool, f, link, { links: [{ po_number: po.number, bill_id: b1.id, external_system: 'sage', external_ref: '4711' }] });
    expect(rerun.body).toMatchObject({ linked: 0, already_existed: 1 });
    expect((rerun.body.links as Json[])[0]).toMatchObject({ already_existed: true, adopted_reference: false, external_system: 'sage', external_ref: '4711' });
    expect(rerun.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);

    const noRef = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    expect(noRef.text).toContain('is already linked to purchase order');
    const stolen = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id, external_system: 'sage', external_ref: '4711' }] });
    expect(stolen.text).toContain('external_ref 4711 (sage) is already used by another purchase order link');

    const found = await callTool(pool, f, find, { source: 'sage', kind: 'po_bill_link', id: 4711 });
    expect(found.body).toMatchObject({ found: true, kind: 'po_bill_link', record: { purchase_order_id: po.po, supplier_invoice_id: b1.id, total_amount: 100 } });
    expect(String((found.body.record as Json).number)).toBe(`${po.number} <- ${String((await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [b1.id])).rows[0].invoice_number)}`);
    const none = await callTool(pool, other, find, { source: 'sage', kind: 'po_bill_link', id: 4711 });
    expect(none.body).toMatchObject({ found: false });
  });

  it('a replay with the same reference but another amount or other lines is refused payload_differs, never a silent already_existed', async () => {
    const po = await seedPo(pool, f, { lines: [60, 40] });
    const bill = await seedBill(pool, f, { lines: [60, 40] });
    const ref = { external_system: 'sage', external_ref: 'PD-1' };
    // bill.lines is in unit_price order: [0] is the R40 line, [1] the R60 one (PR #1703 BRK-A: an amount beside lines is theirs).
    const made = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, amount: 60, lines: [{ po_item_id: po.items[1], bill_line_id: bill.lines[1] }], ...ref }] });
    expect(made.isError, made.text).toBe(false);
    const sameAmount = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, amount: 40, ...ref }] });
    expect(sameAmount.isError).toBe(true);
    expect(sameAmount.text).toContain('payload_differs');
    expect(sameAmount.text).toContain('amount 40.00 against 60.00 stored');
    const otherLines = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }], ...ref }] });
    expect(otherLines.text).toContain('payload_differs');
    expect(otherLines.text).toContain('the lines named are not the lines linked');
    const same = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, amount: 60, lines: [{ po_item_id: po.items[1], bill_line_id: bill.lines[1] }], ...ref }] });
    expect(same.body).toMatchObject({ linked: 0, already_existed: 1 });
  });

  it('a ref-less app / backfill link ADOPTS the reference (Sage load over an app-linked bill); a differing amount or lines are refused', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await pool.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by)
                      VALUES ($1, $2, $3, 100, 'app', $4)`, [f.co, po.po, bill.id, f.owner]);
    const differing = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, amount: 99, external_system: 'sage', external_ref: 'ADOPT-1' }] });
    expect(differing.text).toContain('payload_differs');
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`))[0]).toMatchObject({ external_ref: null, source: 'app' });

    const dry = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, external_system: 'sage', external_ref: 'ADOPT-1' }], dry_run: true });
    expect(dry.body).toMatchObject({ would_adopt_reference: 1 });
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`))[0]!.external_ref).toBeNull();
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, amount: 100, external_system: 'Sage', external_ref: 'ADOPT-1' }] });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ linked: 0, adopted_reference: 1, already_existed: 1 });
    expect(r.wroteNothing).toBe(false);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`))[0]).toMatchObject({ external_system: 'sage', external_ref: 'ADOPT-1', source: 'app', amount: '100.00' });
    const audit = await pool.query(`SELECT changes FROM audit_log WHERE entity_id = $1 AND entity_type = 'purchase_order' ORDER BY created_at DESC, id LIMIT 1`, [po.po]);
    expect(audit.rows[0].changes.metadata).toMatchObject({ adopted_reference: 'true', externalRef: 'ADOPT-1' });
    const again = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, external_system: 'sage', external_ref: 'ADOPT-1' }] });
    expect(again.wroteNothing).toBe(true);
    const found = await callTool(pool, f, find, { source: 'sage', kind: 'po_bill_link', id: 'ADOPT-1' });
    expect(found.body).toMatchObject({ found: true });
    // A reference can be adopted only once and by one pair.
    const other2 = await seedBill(pool, f, { lines: [100] });
    await pool.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'backfill')`, [f.co, po.po, other2.id]);
    const stolen = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: other2.id, external_system: 'sage', external_ref: 'ADOPT-1' }] });
    expect(stolen.text).toContain('is already used by another purchase order link');
  });
});

describe('dry_run', () => {
  it('writes nothing, leaves the key free, and refuses what the live call refuses', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const bill = await seedBill(pool, f, { lines: [100] });
    const before = await ledgerSnapshot(pool, f, [bill.id]);
    const args = { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }], close_when_fully_billed: true, idempotency_key: 'dry-then-live' };
    const dry = await callTool(pool, f, link, { ...args, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, would_link: 1 });
    expect((dry.body.links as Json[])[0]).toMatchObject({ link_id: null, amount: 100 });
    expect((dry.body.purchase_orders as Json[])[0]).toMatchObject({ status: 'closed', closed_by_this_call: true });
    expect(dry.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    expect(await poStatus(pool, po.po)).toBe('approved');
    expect(await lineLinks(pool, bill.id)).toEqual([null]);
    expect(await billHeader(pool, bill.id)).toBeNull();
    expect(await ledgerSnapshot(pool, f, [bill.id])).toEqual(before);

    const live = await callTool(pool, f, link, args);
    expect(live.isError, live.text).toBe(false);
    expect(live.body).toMatchObject({ linked: 1 });
    expect(await poStatus(pool, po.po)).toBe('closed');

    const refusedDry = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], dry_run: true });
    const refusedLive = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] });
    expect(refusedDry.isError).toBe(true);
    expect(refusedDry.text).toBe(refusedLive.text);
  });
});

