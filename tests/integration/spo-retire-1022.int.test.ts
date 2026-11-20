/**
 * Migration 1022: supplier_purchase_orders (SPO) retired into purchase_orders + po_items, real PostgreSQL 16.
 * Seeds legacy POs in every status (a discount line, a 4-dp quantity, a same-company item and another company's item and
 * account, a cost centre, internal notes and a project, a number the canonical table already holds twice, a line the
 * canonical CHECKs refuse, another company's supplier, a canonical-form number above the counter) plus a posted bill whose
 * header names a legacy id, runs the migration file, and asserts: same ids, totals to the cent, the status map with
 * closed_from_status, the renamed number with its reference, the bill's link, the counter, a re-run that changes nothing,
 * the legacy tables refusing writes as app_user, and nothing crossing companies.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, canonicalSnapshot, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
const S: Record<string, SeededSpo> = {};
let itemMine = '';
let itemTheirs = '';
let bill = '';
let notices: string[] = [];

const head = async (id: string) => (await pool.query(
  `SELECT company_id, po_number, supplier_id, order_date::TEXT AS order_date, expected_delivery_date::TEXT AS delivery, status,
          closed_from_status, subtotal::TEXT AS subtotal, tax_amount::TEXT AS tax, total::TEXT AS total, notes, reference, created_by,
          external_system, external_ref, external_document_number FROM purchase_orders WHERE id = $1`, [id])).rows[0];
const lines = async (po: string) => (await pool.query(
  `SELECT id, description, quantity::TEXT AS qty, unit_price::TEXT AS price, line_total::TEXT AS total, tax_amount::TEXT AS tax,
          tax_rate::TEXT AS rate, quantity_received::TEXT AS received, quantity_invoiced::TEXT AS invoiced, item_id, gl_account_id,
          cc1_id, cc2_id, sort_order, round(quantity * unit_price, 2)::TEXT AS recomputed
     FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order`, [po])).rows;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-retire');
  other = await seedBillFixture(pool, 'spo-retire-other');
  itemMine = String((await pool.query(`INSERT INTO items (company_id, code, description) VALUES ($1, 'SPO-ITEM', 'Mine') RETURNING id`, [f.co])).rows[0].id);
  itemTheirs = String((await pool.query(`INSERT INTO items (company_id, code, description) VALUES ($1, 'SPO-ITEM', 'Theirs') RETURNING id`, [other.co])).rows[0].id);
  await pool.query(`INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding) VALUES ($1, 'purchase_order', 'PO', 5, 7)`, [f.co]);
  await seedPo(pool, f, { lines: [1], number: 'SPO-COL-1', status: 'draft' });
  await seedPo(pool, f, { lines: [1], number: 'SPO-COL-1-SPO', status: 'draft' });
  const stranger = await seedSupplier(pool, other, 'Their supplier');
  const base = { co: f.co, supplier: f.supplier };
  await asBeforeRetirement(pool, async (c) => {
    S.draft = await seedSpo(c, { ...base, number: 'SPO-D1', status: 'draft', lines: [{ qty: 2, price: 50 }],
      notes: 'Deliver to gate 3', internalNotes: 'Haggled down', project: '00000000-0000-4000-8000-0000000000aa', costCentre: f.cc.FT });
    S.nullStatus = await seedSpo(c, { ...base, number: 'SPO-N1', status: null, lines: [{ qty: 1, price: 10 }], orderDate: null });
    S.sent = await seedSpo(c, { ...base, number: 'SPO-S1', status: 'sent', deliveryDate: '2026-06-30',
      lines: [{ qty: 3, price: 100, discount: 10 }, { qty: 1.2345, price: 80.01, item: itemMine }, { qty: 1, price: 5, item: itemTheirs, gl: other.acc.opex }] });
    S.partRecv = await seedSpo(c, { ...base, number: 'SPO-PR1', status: 'partially_received', lines: [{ qty: 4, price: 25, received: 1, gl: f.acc.opex }] });
    S.received = await seedSpo(c, { ...base, number: 'SPO-R1', status: 'received', lines: [{ qty: 2, price: 30, received: 2 }] });
    S.piFull = await seedSpo(c, { ...base, number: 'SPO-PI1', status: 'partially_invoiced',
      lines: [{ qty: 2, price: 10, received: 2, invoiced: 1 }, { qty: 1, price: 10, received: 1 }] });
    S.piPart = await seedSpo(c, { ...base, number: 'SPO-PI2', status: 'partially_invoiced',
      lines: [{ qty: 2, price: 10, received: 2, invoiced: 2 }, { qty: 3, price: 10, received: 1 }] });
    S.invoiced = await seedSpo(c, { ...base, number: 'SPO-I1', status: 'invoiced', lines: [{ qty: 1, price: 99.99, received: 1, invoiced: 1 }] });
    S.cancelled = await seedSpo(c, { ...base, number: 'SPO-C1', status: 'cancelled', lines: [{ qty: 1, price: 1 }] });
    S.collide = await seedSpo(c, { ...base, number: 'SPO-COL-1', status: 'draft', lines: [{ qty: 1, price: 7 }] });
    S.canonForm = await seedSpo(c, { ...base, number: 'PO0000042', status: 'draft', lines: [{ qty: 1, price: 1 }] });
    S.zeroQty = await seedSpo(c, { ...base, number: 'SPO-Z1', status: 'draft', lines: [{ qty: 1, price: 1 }, { qty: 0.001, price: 1, lineTotal: 0 }] });
    S.foreignSupplier = await seedSpo(c, { ...base, number: 'SPO-F1', supplier: stranger, status: 'draft', lines: [{ qty: 1, price: 1 }] });
    S.theirs = await seedSpo(c, { co: other.co, supplier: other.supplier, number: 'SPO-D1', status: 'sent', lines: [{ qty: 1, price: 11 }] });
  });
  // A posted bill of the same supplier whose header names the legacy SPO-S1 id.
  bill = (await seedRawBill(pool, f, { items: [{ total: 100 }], subtotal: 100, total: 115, header: S.sent!.id })).id;
  notices = await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f && other) {
      await dropLegacy(pool, [f.co, other.co]);
      await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = ANY($1::UUID[]))', [[f.co, other.co]]);
      await pool.query('DELETE FROM items WHERE company_id = ANY($1::UUID[])', [[f.co, other.co]]);
    }
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally { await pool.end(); }
}, 60_000);

describe('the copy', () => {
  it('copies every legacy header and line under its own id, with the figures to the cent', async () => {
    const h = await head(S.sent!.id);
    expect(h).toMatchObject({ company_id: f.co, po_number: 'SPO-S1', supplier_id: f.supplier, order_date: '2026-05-01', delivery: '2026-06-30',
      subtotal: S.sent!.subtotal, tax: S.sent!.tax, total: S.sent!.total, reference: 'REF-SPO-S1', external_ref: null });
    const ls = await lines(S.sent!.id);
    expect(ls.map((l) => l.id)).toEqual(S.sent!.items);
    // The discount line: net unit price 90 (100 less 10%), 3 x 90 = 270.00.
    expect(ls[0]).toMatchObject({ qty: '3.00', price: '90.000000', total: '270.00', tax: '40.50', rate: '15.00', sort_order: 0 });
    // A 4-dp quantity: 2 dp, the price re-derived so the stored line total is unchanged.
    expect(ls[1]).toMatchObject({ qty: '1.23', total: '98.77', item_id: itemMine });
    // Another company's item and account are not carried.
    expect(ls[2]).toMatchObject({ item_id: null, gl_account_id: null, total: '5.00' });
    for (const l of ls) expect(l.recomputed).toBe(l.total);
    const sum = ls.reduce((a, l) => a + Math.round(Number(l.total) * 100), 0);
    expect((sum / 100).toFixed(2)).toBe(S.sent!.subtotal);
    expect((await lines(S.partRecv!.id))[0]).toMatchObject({ received: '1.00', gl_account_id: f.acc.opex });
    expect((await lines(S.piFull!.id))[0]).toMatchObject({ received: '2.00', invoiced: '1.00' });
  });

  it('maps every status, with the closed_from_status the 1007 CHECK allows', async () => {
    const got = async (k: string) => { const h = await head(S[k]!.id); return [h.status, h.closed_from_status]; };
    expect(await got('draft')).toEqual(['draft', null]);
    expect(await got('nullStatus')).toEqual(['draft', null]);
    expect(await got('sent')).toEqual(['approved', null]);
    expect(await got('partRecv')).toEqual(['partially_received', null]);
    expect(await got('received')).toEqual(['received', null]);
    expect(await got('piFull')).toEqual(['closed', 'received']);
    expect(await got('piPart')).toEqual(['closed', 'partially_received']);
    expect(await got('invoiced')).toEqual(['closed', 'received']);
    expect(await got('cancelled')).toEqual(['cancelled', null]);
  });

  it('keeps internal notes, the project and a mapped cost centre, and defaults a missing order date', async () => {
    const h = await head(S.draft!.id);
    expect(h.notes).toContain('Deliver to gate 3');
    expect(h.notes).toContain('Internal notes: Haggled down');
    expect(h.notes).toContain('00000000-0000-4000-8000-0000000000aa');
    expect((await lines(S.draft!.id))[0]).toMatchObject({ cc1_id: f.cc.FT, cc2_id: null });
    expect((await head(S.nullStatus!.id)).order_date).toBe('2026-05-01');
  });

  it('renames a number the canonical table already holds, keeps the original as its reference and says so', async () => {
    expect(await head(S.collide!.id)).toMatchObject({ po_number: 'SPO-COL-1-SPO2', external_system: 'supplier_purchase_orders',
      external_ref: S.collide!.id, external_document_number: 'SPO-COL-1' });
    expect(notices.some((n) => n.includes('SPO-COL-1') && n.includes('SPO-COL-1-SPO2'))).toBe(true);
  });

  it('skips, with a warning, an order the canonical CHECKs or the supplier fence refuse, and leaves it in the legacy table', async () => {
    expect(await head(S.zeroQty!.id)).toBeUndefined();
    expect(await head(S.foreignSupplier!.id)).toBeUndefined();
    expect(notices.some((n) => n.includes(S.zeroQty!.id))).toBe(true);
    expect(notices.some((n) => n.includes(S.foreignSupplier!.id))).toBe(true);
    expect(Number((await pool.query('SELECT count(*) FROM supplier_purchase_orders WHERE id = ANY($1::UUID[])',
      [[S.zeroQty!.id, S.foreignSupplier!.id]])).rows[0].count)).toBe(2);
  });

  it('links the posted bill that named the legacy id, and raises the counter past a copied number of its form', async () => {
    const links = await linkRows(pool, f, `l.supplier_invoice_id = '${bill}'`);
    expect(links.map((l) => [l.po, l.amount, l.source])).toEqual([[S.sent!.id, '100.00', 'backfill']]);
    const counter = (await pool.query(`SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'purchase_order'`, [f.co])).rows[0];
    expect(Number(counter.next_number)).toBe(43);
    expect(notices.some((n) => /1022: copied/.test(n))).toBe(true);
  });

  it('keeps each company to itself: the other company\'s SPO-D1 is copied into the other company, unrenamed', async () => {
    expect(await head(S.theirs!.id)).toMatchObject({ company_id: other.co, po_number: 'SPO-D1', status: 'approved', supplier_id: other.supplier });
    const mine = (await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 AND id = ANY($2::UUID[])',
      [f.co, [S.theirs!.id]])).rows[0].n;
    expect(mine).toBe(0);
    expect(await linkRows(pool, other)).toEqual([]);
  });

  it('a re-run changes nothing', async () => {
    const before = await canonicalSnapshot(pool, [f.co, other.co]);
    await runMigration(pool);
    expect(await canonicalSnapshot(pool, [f.co, other.co])).toBe(before);
  });
});

describe('the retired tables refuse writes, as app_user', () => {
  const asApp = async (sqlText: string, params: unknown[]) => {
    const req = await openRequest(pool, f, f.owner);
    try { await req.client.query(sqlText, params); } finally { await req.rollback(); }
  };
  const retired = /retired.*use purchase_orders/;
  it('refuses an insert, an update and the delete of an order with no canonical copy', async () => {
    await expect(asApp(`INSERT INTO supplier_purchase_orders (company_id, order_number, supplier_id) VALUES ($1, 'NEW-1', $2)`, [f.co, f.supplier]))
      .rejects.toThrow(retired);
    await expect(asApp(`UPDATE supplier_purchase_orders SET notes = 'x' WHERE id = $1`, [S.draft!.id])).rejects.toThrow(retired);
    await expect(asApp(`INSERT INTO supplier_purchase_order_items (purchase_order_id, description) VALUES ($1, 'x')`, [S.draft!.id]))
      .rejects.toThrow(retired);
    await expect(asApp(`UPDATE supplier_purchase_order_items SET description = 'x' WHERE id = $1`, [S.draft!.items[0]])).rejects.toThrow(retired);
    await expect(asApp('DELETE FROM supplier_purchase_orders WHERE id = $1', [S.zeroQty!.id])).rejects.toThrow(retired);
    await expect(asApp('DELETE FROM supplier_purchase_order_items WHERE id = $1', [S.zeroQty!.items[0]])).rejects.toThrow(retired);
  });

  it('allows the delete of an order (and its lines) that has its canonical copy: the wipe paths, and nothing is lost', async () => {
    await expect(asApp('DELETE FROM supplier_purchase_orders WHERE id = $1', [S.cancelled!.id])).resolves.toBeUndefined();
  });

  it('refuses for every session: session_replication_role = replica does not switch the triggers off', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await expect(c.query(`UPDATE supplier_purchase_orders SET notes = 'x' WHERE id = $1`, [S.draft!.id])).rejects.toThrow(retired);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
