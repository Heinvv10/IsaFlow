/**
 * Migration 1022: supplier_purchase_orders (SPO) retired into purchase_orders + po_items, real PostgreSQL 16: the copy.
 * Seeds legacy POs in every status and every billing-evidence shape (a live bill of any status, a soft-deleted bill, another
 * company's bill, another supplier's bill, an invoiced line, an invoiced status), a discount line, a 4-dp quantity, a quantity
 * that rounds to 0 and one too large to price at 2 dp, a zero-line order, items / accounts / cost centres of this company and
 * another, a number the canonical table holds twice, and the skip shapes (another company's supplier, a negative total, a line
 * id po_items holds). Runs the migration file and asserts: same ids, figures to the cent, the status map with
 * closed_from_status, the units rule, the notes, the skips with their records, the bill links, the exact NOTICE counts and
 * the committed record. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
const S: Record<string, SeededSpo> = {};
let itemMine = '';
let itemTheirs = '';
let cc2 = '';
const bills: Record<string, string> = {};
let notices: string[] = [];

const head = async (id: string) => (await pool.query(
  `SELECT company_id, po_number, supplier_id, order_date::TEXT AS order_date, expected_delivery_date::TEXT AS delivery, status,
          closed_from_status, subtotal::TEXT AS subtotal, tax_amount::TEXT AS tax, total::TEXT AS total, notes, reference, created_by,
          external_system, external_ref, external_document_number, approved_by, approved_at FROM purchase_orders WHERE id = $1`, [id])).rows[0];
const lines = async (po: string) => (await pool.query(
  `SELECT id, description, quantity::TEXT AS qty, unit_price::TEXT AS price, line_total::TEXT AS total, tax_amount::TEXT AS tax,
          tax_rate::TEXT AS rate, quantity_received::TEXT AS received, quantity_invoiced::TEXT AS invoiced, item_id, gl_account_id,
          cc1_id, cc2_id, sort_order, round(quantity * unit_price, 2)::TEXT AS recomputed
     FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order`, [po])).rows;
const status = async (k: string) => { const h = await head(S[k]!.id); return [h.status, h.closed_from_status]; };
const cents = (keys: string[]) => keys.reduce((a, k) => a + Math.round(Number(S[k]!.subtotal) * 100), 0);

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-retire');
  other = await seedBillFixture(pool, 'spo-retire-other');
  itemMine = String((await pool.query(`INSERT INTO items (company_id, code, description) VALUES ($1, 'SPO-ITEM', 'Mine') RETURNING id`, [f.co])).rows[0].id);
  itemTheirs = String((await pool.query(`INSERT INTO items (company_id, code, description) VALUES ($1, 'SPO-ITEM', 'Theirs') RETURNING id`, [other.co])).rows[0].id);
  cc2 = String((await pool.query(`INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'P1', 'Project one', 'cc2') RETURNING id`, [f.co])).rows[0].id);
  await seedPo(pool, f, { lines: [1], number: 'SPO-COL-1', status: 'draft' });
  const taken = await seedPo(pool, f, { lines: [1], number: 'SPO-COL-1-SPO', status: 'draft' });
  const stranger = await seedSupplier(pool, other, 'Their supplier');
  const base = { co: f.co, supplier: f.supplier };
  const one = (received = 0, invoiced = 0) => [{ qty: 2, price: 50, received, invoiced }];
  await asBeforeRetirement(pool, async (c) => {
    const at = async (k: string, number: string, st: string | null, ls: Parameters<typeof seedSpo>[1]['lines'], extra = {}) => {
      S[k] = await seedSpo(c, { ...base, number, status: st, lines: ls, ...extra });
    };
    await at('draft', 'SPO-D1', 'draft', [{ qty: 2, price: 50 }], { notes: 'Deliver to gate 3', internalNotes: 'Haggled down',
      project: '00000000-0000-4000-8000-0000000000aa', costCentre: f.cc.FT });
    await at('draftCc2', 'SPO-D2', 'draft', one(), { costCentre: cc2 });
    await at('draftForeignCc', 'SPO-D3', 'draft', one(), { costCentre: other.cc.FT });
    await at('nullStatus', 'SPO-N1', null, [{ qty: 1, price: 10 }], { orderDate: null });
    await at('sent', 'SPO-S1', 'sent', [{ qty: 3, price: 100, discount: 10 }, { qty: 1.2345, price: 80.01, item: itemMine },
      { qty: 1, price: 5, item: itemTheirs, gl: other.acc.opex }], { deliveryDate: '2026-06-30' });
    await at('sentClean', 'SPO-S2', 'sent', one());
    await at('partRecv', 'SPO-PR1', 'partially_received', [{ qty: 4, price: 25, received: 1, gl: f.acc.opex }]);
    await at('received', 'SPO-R1', 'received', [{ qty: 2, price: 30, received: 2 }]);
    await at('piFull', 'SPO-PI1', 'partially_invoiced', [{ qty: 2, price: 10, received: 2, invoiced: 1 }, { qty: 1, price: 10, received: 1 }]);
    await at('piPart', 'SPO-PI2', 'partially_invoiced', [{ qty: 2, price: 10, received: 2, invoiced: 2 }, { qty: 3, price: 10, received: 1 }]);
    await at('invoiced', 'SPO-I1', 'invoiced', [{ qty: 1, price: 99.99, received: 1, invoiced: 1 }]);
    await at('invoicedNoTrace', 'SPO-I2', 'invoiced', [{ qty: 1, price: 9, received: 1 }]);
    await at('sentCancelledBill', 'SPO-E8', 'sent', one());
    await at('sentDraftBill', 'SPO-E1', 'sent', one(2));
    await at('sentInvoicedLine', 'SPO-E2', 'sent', one(0, 1));
    await at('sentDeletedBill', 'SPO-E3', 'sent', one());
    await at('sentForeignBill', 'SPO-E4', 'sent', one());
    await at('sentStrangerBill', 'SPO-E5', 'sent', one());
    await at('draftBilled', 'SPO-E6', 'draft', one(0, 1));
    await at('cancelledBilled', 'SPO-E7', 'cancelled', one(0, 1));
    await at('cancelled', 'SPO-C1', 'cancelled', [{ qty: 1, price: 1 }]);
    await at('collide', 'SPO-COL-1', 'draft', [{ qty: 1, price: 7 }]);
    await at('tiny', 'SPO-T1', 'draft', [{ qty: 1, price: 4 }, { qty: 0.001, price: 10, lineTotal: 0.01 }]);
    await at('drift', 'SPO-T2', 'draft', [{ qty: 12345.6789, price: 1.23, lineTotal: 15185.18, received: 6172.84 }]);
    await at('empty', 'SPO-Z0', 'draft', []);
    await at('negative', 'SPO-X1', 'draft', [{ qty: 1, price: 10 }, { qty: 1, price: 0, lineTotal: -5 }]);
    await at('idCollision', 'SPO-X2', 'draft', [{ qty: 1, price: 10, id: taken.items[0] }]);
    await at('foreignSupplier', 'SPO-X3', 'draft', [{ qty: 1, price: 1 }], { supplier: stranger });
    S.theirs = await seedSpo(c, { co: other.co, supplier: other.supplier, number: 'SPO-D1', status: 'sent', lines: [{ qty: 1, price: 11 }] });
  });
  const bill = (fx: BillFixture, k: string, o: { status?: string; supplier?: string } = {}) =>
    seedRawBill(pool, fx, { items: [{ total: 100 }], subtotal: 100, total: 115, header: S[k]!.id, ...o }).then((b) => b.id);
  bills.sent = await bill(f, 'sent');
  bills.draft = await bill(f, 'sentDraftBill', { status: 'draft' });
  bills.deleted = await bill(f, 'sentDeletedBill');
  await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bills.deleted]);
  // Another company's bill, even one naming this company's supplier (corrupt data), is no evidence.
  bills.foreign = await bill(other, 'sentForeignBill', { supplier: f.supplier });
  bills.cancelled = await bill(f, 'sentCancelledBill', { status: 'cancelled' });
  bills.stranger = await bill(f, 'sentStrangerBill', { supplier: await seedSupplier(pool, f, 'Bill stranger') });
  bills.draftBilled = await bill(f, 'draftBilled');
  notices = await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f && other) { await dropLegacy(pool, [f.co, other.co]); await dropCanonical(pool, [f.co, other.co]); }
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally { await pool.end(); }
}, 60_000);

describe('the copy', () => {
  it('copies every legacy header and line under its own id, with the figures to the cent', async () => {
    expect(await head(S.sent!.id)).toMatchObject({ company_id: f.co, po_number: 'SPO-S1', supplier_id: f.supplier, order_date: '2026-05-01',
      delivery: '2026-06-30', subtotal: S.sent!.subtotal, tax: S.sent!.tax, total: S.sent!.total, reference: 'REF-SPO-S1',
      external_system: null, external_ref: null, external_document_number: null, approved_by: null, approved_at: null });
    const ls = await lines(S.sent!.id);
    expect(ls.map((l) => l.id)).toEqual(S.sent!.items);
    expect(ls[0]).toMatchObject({ qty: '3.00', price: '90.000000', total: '270.00', tax: '40.50', rate: '15.00', sort_order: 0 });
    expect(ls[1]).toMatchObject({ qty: '1.23', total: '98.77', item_id: itemMine, description: 'Line 1' });
    expect(ls[2]).toMatchObject({ item_id: null, gl_account_id: null, total: '5.00' });
    for (const l of ls) expect(l.recomputed).toBe(l.total);
    expect((ls.reduce((a, l) => a + Math.round(Number(l.total) * 100), 0) / 100).toFixed(2)).toBe(S.sent!.subtotal);
    expect((await lines(S.partRecv!.id))[0]).toMatchObject({ received: '1.00', gl_account_id: f.acc.opex });
    expect((await lines(S.piFull!.id))[0]).toMatchObject({ received: '2.00', invoiced: '1.00' });
    expect(await head(S.empty!.id)).toMatchObject({ status: 'draft', subtotal: '0.00' });
    expect(await lines(S.empty!.id)).toEqual([]);
  });

  it('copies a line it cannot price at 2 dp as 1 unit at its total, its own quantity and price in the description', async () => {
    const tiny = await lines(S.tiny!.id);
    expect(tiny[1]).toMatchObject({ qty: '1.00', price: '0.010000', total: '0.01', description: 'Line 1 (qty 0.001 @ 10)', recomputed: '0.01' });
    expect(tiny[0]).toMatchObject({ qty: '1.00', price: '4.000000', description: 'Line 0' });
    expect((await lines(S.drift!.id))[0]).toMatchObject({ qty: '1.00', price: '15185.180000', total: '15185.18',
      description: 'Line 0 (qty 12345.6789 @ 1.23)', received: '0.50' });
    expect(notices.filter((n) => n.includes('as 1 unit at the line total')).length).toBe(2);
  });
});

describe('the status map', () => {
  it('keeps draft and cancelled, and the committing statuses when there is no billing evidence', async () => {
    expect(await status('draft')).toEqual(['draft', null]);
    expect(await status('nullStatus')).toEqual(['draft', null]);
    expect(await status('draftBilled')).toEqual(['draft', null]);
    expect(await status('cancelled')).toEqual(['cancelled', null]);
    expect(await status('cancelledBilled')).toEqual(['cancelled', null]);
    expect(await status('sentClean')).toEqual(['approved', null]);
    expect(await status('partRecv')).toEqual(['partially_received', null]);
    expect(await status('received')).toEqual(['received', null]);
  });

  it('closes an order with billing evidence, from received / partially_received / approved by quantity, with a NOTICE each', async () => {
    expect(await status('sent')).toEqual(['closed', 'approved']);
    expect(await status('sentDraftBill')).toEqual(['closed', 'received']);
    expect(await status('sentInvoicedLine')).toEqual(['closed', 'approved']);
    expect(await status('piFull')).toEqual(['closed', 'received']);
    expect(await status('piPart')).toEqual(['closed', 'partially_received']);
    expect(await status('invoiced')).toEqual(['closed', 'received']);
    // The legacy status alone is evidence: no invoiced line, no bill.
    expect(await status('invoicedNoTrace')).toEqual(['closed', 'received']);
    for (const k of ['sent', 'sentDraftBill', 'sentInvoicedLine', 'piFull', 'piPart', 'invoiced', 'invoicedNoTrace']) {
      expect(notices.some((n) => n.includes(S[k]!.id) && n.includes('billing evidence')), k).toBe(true);
    }
  });

  it('ignores a cancelled bill, a soft-deleted bill, another company\'s bill and another supplier\'s bill', async () => {
    for (const k of ['sentCancelledBill', 'sentDeletedBill', 'sentForeignBill', 'sentStrangerBill']) expect(await status(k), k).toEqual(['approved', null]);
  });

  it('still links the bills that named a legacy id (a closed PO is linkable)', async () => {
    const got = (await linkRows(pool, f)).filter((l) => [bills.sent, bills.draft].includes(l.bill)).map((l) => [l.bill, l.po, l.source]);
    expect(got.sort()).toEqual([[bills.sent, S.sent!.id, 'backfill'], [bills.draft, S.sentDraftBill!.id, 'backfill']].sort());
  });
});

describe('the header', () => {
  it('keeps internal notes, the project and a CC1 / CC2 cost centre; another company\'s centre goes to the notes', async () => {
    const h = await head(S.draft!.id);
    expect(h.notes).toBe('Deliver to gate 3\n\nInternal notes: Haggled down\n\nProject (from the retired supplier purchase order): 00000000-0000-4000-8000-0000000000aa');
    expect((await lines(S.draft!.id))[0]).toMatchObject({ cc1_id: f.cc.FT, cc2_id: null });
    expect((await lines(S.draftCc2!.id))[0]).toMatchObject({ cc1_id: null, cc2_id: cc2 });
    expect((await lines(S.draftForeignCc!.id))[0]).toMatchObject({ cc1_id: null, cc2_id: null });
    expect((await head(S.draftForeignCc!.id)).notes).toContain(`not a CC1 / CC2 of this company): ${other.cc.FT}`);
    expect((await head(S.nullStatus!.id)).order_date).toBe('2026-05-01');
  });

  it('renames a taken number, keeps the original in its notes (no external reference on any copy) and says so', async () => {
    expect(await head(S.collide!.id)).toMatchObject({ po_number: 'SPO-COL-1-SPO2', notes: 'was SPO SPO-COL-1', external_ref: null });
    expect(notices.some((n) => n.includes('SPO-COL-1') && n.includes('copied as SPO-COL-1-SPO2'))).toBe(true);
    const refs = (await pool.query(`SELECT count(*)::INT AS n FROM purchase_orders WHERE id = ANY($1::UUID[]) AND
      (external_ref IS NOT NULL OR external_system IS NOT NULL OR external_document_number IS NOT NULL)`, [Object.values(S).map((x) => x.id)])).rows[0].n;
    expect(refs).toBe(0);
  });
});

describe('the skips and the record', () => {
  it('skips another company\'s supplier, a negative total and a line id po_items holds, records each, leaves them in place', async () => {
    const skipped = { foreignSupplier: 'supplier of another company', negative: 'negative line total', idCollision: 'line id already in po_items' };
    for (const [k, reason] of Object.entries(skipped)) {
      expect(await head(S[k]!.id), k).toBeUndefined();
      expect(notices.some((n) => n.includes(S[k]!.id) && n.includes(reason)), k).toBe(true);
      expect((await pool.query('SELECT reason FROM supplier_purchase_orders_retired_skips WHERE id = $1', [S[k]!.id])).rows).toEqual([{ reason }]);
      expect((await pool.query('SELECT 1 FROM supplier_purchase_orders WHERE id = $1', [S[k]!.id])).rowCount, k).toBe(1);
    }
  });

  it('says exactly what it did, and what entered committed spend', async () => {
    expect(notices).toContain('1022: copied 26 order(s) in all, 3 skipped, 1 renamed, 7 closed for billing evidence, 2 line(s) as 1 unit');
    expect(notices).toContain('1022: skipped per reason: 1 supplier of another company, 1 negative line total, 1 line id already in po_items, '
      + '0 id already a purchase order of another company, 0 refused by the database');
    const committing = ['sentClean', 'partRecv', 'received', 'sentDeletedBill', 'sentForeignBill', 'sentStrangerBill', 'sentCancelledBill'];
    expect(notices).toContain(`1022: company ${f.co} committing copies, order month 2026-05: 7 order(s), R ${(cents(committing) / 100).toFixed(2)} ex VAT`);
    expect(notices).toContain(`1022: company ${other.co} committing copies, order month 2026-05: 1 order(s), R 11.00 ex VAT`);
  });
});
