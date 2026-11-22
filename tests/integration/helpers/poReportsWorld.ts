/**
 * The PO report suites' world (docs/design/mcp-po-reports.md): one company on the P5-2 bill fixture (opex BB-6100 budgeted at CC1
 * FT 1 000 / HT 0 a month, travel BB-6200 at company level 500 a month, nob BB-6300 unbudgeted), two CC2 centres, a second
 * supplier and one PO per committed-spend case, each with a name so a test reads its own figures. Seeded as the superuser; the
 * tools run through the real registry as app_user (mcpBudgetFixture.mcp). Disposable databases only.
 */
import type { Pool } from 'pg';
import { seedBillFixture, setPolicy, type BillFixture } from './budgetBillFixture';
import { seedBill, seedRawBill, seedSupplier } from './poBillLinkHarness';
import type { SetupUser } from './onboardingSetupFixture';

export interface PoLineSeed { acct: string | null; qty?: number; price: number; cc1?: string | null; cc2?: string | null; bu?: string | null; received?: number; lineTotal?: number }
export interface SeededPo { po: string; number: string; items: string[] }

let seq = 0;

/** A PO of the given lines (qty default 1), dated `${month}-02`. line_total = qty x price; the header subtotal is their sum. */
export async function mkPo(
  pool: Pool, f: BillFixture, o: {
    month: string; lines: PoLineSeed[]; status?: string; supplier?: string; closedByBilling?: boolean; closedFrom?: string | null; date?: string; number?: string;
  },
): Promise<SeededPo> {
  const po = crypto.randomUUID();
  const number = o.number ?? `PR${String(100 + seq++)}-${po.slice(0, 4)}`;
  const subtotal = Math.round(o.lines.reduce((s, l) => s + (l.lineTotal ?? (l.qty ?? 1) * l.price), 0) * 100) / 100;
  await pool.query(
    `INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total, closed_by_billing, closed_from_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, $8, $9)`,
    [po, f.co, number, o.supplier ?? f.supplier, o.date ?? `${o.month}-02`, o.status ?? 'approved', subtotal, o.closedByBilling ?? false, o.closedFrom ?? null]);
  const items: string[] = [];
  for (const [i, l] of o.lines.entries()) {
    const item = crypto.randomUUID();
    await pool.query(
      `INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, quantity_received, gl_account_id,
         cc1_id, cc2_id, bu_id, sort_order) VALUES ($1, $2, $3, $4, $5, 0, $6, 0, $7, $8, $9, $10, $11, $12)`,
      [item, po, `PO line ${i}`, l.qty ?? 1, l.price, l.lineTotal ?? Math.round((l.qty ?? 1) * l.price * 100) / 100, l.received ?? 0, l.acct, l.cc1 ?? null, l.cc2 ?? null, l.bu ?? null, i]);
    items.push(item);
  }
  return { po, number, items };
}

/**
 * A goods received note on `po`'s lines (qty per line id); returns its id. The note and its items go in ONE transaction, as the app writes
 * them (migration 1021 refuses an item added to a note outside the transaction that created it). `po_items.quantity_received` is the
 * caller's to set on the PO's lines (mkPo `received`), as createGoodsReceived adds to it.
 */
export async function mkGrn(pool: Pool, f: BillFixture, po: SeededPo, qty: Array<[string, number]>, date: string, status = 'received'): Promise<string> {
  const grn = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_date, received_by, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [grn, f.co, `GRN-${grn.slice(0, 8)}`, po.po, date, 'tester', status]);
    for (const [item, q] of qty) await client.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, $3)', [grn, item, q]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return grn;
}

export const linkLine = (pool: Pool, billLine: string, poItem: string) =>
  pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE id = $1', [billLine, poItem]);

export interface World {
  f: BillFixture; u: SetupUser; cc2: { A: string; B: string }; sup2: string;
  /** Committed-spend cases by name. */
  po: Record<string, SeededPo>;
  /** The bills that were seeded, by case. */
  bills: Record<string, string>;
}

export const asUser = (f: BillFixture): SetupUser => ({ userId: f.owner, homeCompanyId: f.co, token: '' });

/**
 * The committed-spend cases, month 2026-06 unless said: partial bill on a line, header-only bill, a negative bill line, a PO
 * closed by billing and then under-billed, a cancelled PO, a manual short-close, two POs on one account and month in different
 * CC2, off-slice and account-less lines, a draft, a PO in another month and one outside the month window.
 */
export async function seedWorld(pool: Pool, tag: string): Promise<World> {
  const f = await seedBillFixture(pool, tag);
  await setPolicy(pool, f, 'off');
  const cc2 = { A: crypto.randomUUID(), B: crypto.randomUUID() };
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'C2A', 'Cc2 A', 'cc2'), ($2, $3, 'C2B', 'Cc2 B', 'cc2')`, [cc2.A, cc2.B, f.co]);
  const sup2 = await seedSupplier(pool, f, 'Second supplier');
  const { opex, travel } = f.acc;
  const FT = f.cc.FT;
  const po: World['po'] = {};
  const bills: World['bills'] = {};

  po.partial = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: opex, price: 100, cc1: FT, cc2: cc2.A }, { acct: opex, price: 200, cc1: FT, cc2: cc2.A }] });
  const b1 = await seedBill(pool, f, { lines: [40] });
  await linkLine(pool, b1.lines[0]!, po.partial.items[0]!);
  bills.partial = b1.id;

  po.header = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: travel, price: 300, cc2: cc2.B }] });
  const b2 = await seedBill(pool, f, { lines: [120] });
  await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [b2.id, po.header.po]);
  bills.header = b2.id;

  po.negative = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: travel, price: 100, cc2: cc2.A }, { acct: travel, price: 100, cc2: cc2.A }] });
  const b3 = await seedRawBill(pool, f, { items: [{ total: 100, poItem: po.negative.items[0] }, { total: -30, poItem: po.negative.items[1] }], subtotal: 70, total: 80.5 });
  bills.negative = b3.id;

  po.closedUnder = await mkPo(pool, f, { month: '2026-06', status: 'closed', closedByBilling: true, lines: [{ acct: opex, price: 400, cc1: FT, cc2: cc2.B }] });
  const b4 = await seedBill(pool, f, { lines: [150] });
  await linkLine(pool, b4.lines[0]!, po.closedUnder.items[0]!);
  bills.closedUnder = b4.id;

  po.cancelled = await mkPo(pool, f, { month: '2026-06', status: 'cancelled', lines: [{ acct: travel, price: 250 }] });
  po.shortClosed = await mkPo(pool, f, { month: '2026-06', status: 'closed', closedFrom: 'approved', lines: [{ acct: opex, price: 175, cc1: FT }] });
  po.twoA = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: travel, price: 200, cc2: cc2.A }] });
  po.twoB = await mkPo(pool, f, { month: '2026-06', supplier: sup2, lines: [{ acct: travel, price: 300, cc2: cc2.B }] });
  po.offSlice = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: opex, price: 90 }, { acct: opex, price: 60, cc1: f.cc.HT }] });
  po.noAccount = await mkPo(pool, f, { month: '2026-06', lines: [{ acct: null, price: 55, cc2: cc2.A }] });
  po.draft = await mkPo(pool, f, { month: '2026-06', status: 'draft', lines: [{ acct: opex, price: 999, cc1: FT }] });
  po.july = await mkPo(pool, f, { month: '2026-07', lines: [{ acct: travel, price: 80 }] });
  po.january = await mkPo(pool, f, { month: '2027-01', lines: [{ acct: travel, price: 70 }] });
  return { f, u: asUser(f), cc2, sup2, po, bills };
}
