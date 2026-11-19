/**
 * The link AMOUNT rule (design decision 4) is one rule in two languages: the migration's backfill (SQL, with
 * po_bill_posted_cents) and the app writer (`recordBillLinks`, TypeScript over `postedExpenseLines`: what approve posts).
 * Real PostgreSQL. Both run on the same bills and must agree to the cent:
 *   - po_bill_posted_cents against postedExpenseLines per line: net bills, a gross-stored bill with a rounding residual, a
 *     R0 line, a negative last line, and 120 random bills;
 *   - the backfill against recordBillLinks per bill: header-only, line-only (header NULL, two POs), header + lines,
 *     lines that post nothing (the fallback), a PO of another supplier / a draft PO / a legacy id / a cancelled bill (none);
 *   - recordBillLinks' own filters: linkable PO statuses, never an amount at or below zero, and an unchanged re-run.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';
import { sql } from '@/lib/neon';
import { postedExpenseLines } from '@/modules/accounting/services/budgets/remainingCommitted';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '@/modules/accounting/services/ap/supplierInvoiceLineOrder';
import { planBillLinks, recordBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-links-amounts'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const c2 = (x: number) => Math.round(x * 100) / 100;
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const req = await openRequest(pool, f, f.owner);
  try { const v = await req.run(fn); await req.commit(); return v; } catch (e) { await req.rollback(); throw e; }
}

/** What approve posts per line, from the TypeScript (cents; a line that posts nothing is 0). */
async function tsPosted(bill: string): Promise<Map<string, number>> {
  return inRequest(async () => {
    const row = ((await sql`SELECT * FROM supplier_invoices WHERE id = ${bill}::UUID`) as Array<Record<string, unknown>>)[0]!;
    const items = (await sql`SELECT sii.* FROM supplier_invoice_items sii WHERE sii.supplier_invoice_id = ${bill}::UUID ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}`) as Array<Record<string, unknown>>;
    const out = new Map<string, number>(items.map((i) => [String(i.id), 0]));
    for (const l of postedExpenseLines(row as never, items as never)) out.set(String(l.description), (out.get(String(l.description)) ?? 0) + Math.round(l.debit * 100));
    return out;
  });
}
async function sqlPosted(bill: string): Promise<Map<string, number>> {
  const r = await pool.query('SELECT item_id, cents FROM po_bill_posted_cents($1)', [bill]);
  return new Map(r.rows.map((x) => [String(x.item_id), Number(x.cents)]));
}

describe('po_bill_posted_cents is expenseLineNets in SQL', () => {
  const grossBill = (lines: number[]) => {
    const total = c2(lines.reduce((s, x) => s + x, 0));
    return { items: lines.map((t) => ({ total: t })), total, subtotal: c2(total / 1.15) };
  };
  const fixtures: Array<[string, Parameters<typeof seedRawBill>[2]]> = [
    ['net bill', { items: [{ total: 100 }, { total: 200 }], subtotal: 300, total: 345 }],
    ['gross-stored with a rounding residual', grossBill([33.33, 33.33, 33.34])],
    ['gross-stored, many lines', grossBill([10.01, 20.02, 30.03, 40.04, 50.05, 60.06, 70.07])],
    ['a R0 line in the middle', { items: [{ total: 150 }, { total: 0 }, { total: 50 }], subtotal: 200, total: 230 }],
    ['a R0 last line carrying the residual', { items: [{ total: 120 }, { total: 0 }], subtotal: 200, total: 230 }],
    ['a negative last line (a discount)', { items: [{ total: 500 }, { total: -50 }], subtotal: 450, total: 517.5 }],
    ['a sub-cent overshoot folded into the largest line', { items: [{ total: 11.5 }, { total: 11.5 }, { total: 11.5 }], subtotal: 30, total: 34.5 }],
    ['a single line', { items: [{ total: 87.65 }], subtotal: 87.65, total: 100.8 }],
  ];
  it.each(fixtures)('%s', async (_name, o) => {
    const bill = await seedRawBill(pool, f, o);
    expect(await sqlPosted(bill.id)).toEqual(await tsPosted(bill.id));
  });

  it('120 random bills (net and gross-stored, R0 lines, residuals) agree line by line', async () => {
    let seed = 20261119;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let b = 0; b < 120; b++) {
      const n = 1 + rnd(6);
      const lines = Array.from({ length: n }, () => (rnd(8) === 0 ? 0 : (1 + rnd(50000)) / 100));
      const sum = c2(lines.reduce((s, x) => s + x, 0));
      const gross = rnd(2) === 0;
      const subtotal = c2(sum + (rnd(3) === 0 ? rnd(5) / 100 : 0));
      const o = gross
        ? { items: lines.map((t) => ({ total: t })), total: sum, subtotal: c2(sum / 1.15) }
        : { items: lines.map((t) => ({ total: t })), subtotal, total: Math.max(c2(sum * 1.15), subtotal) };
      const bill = await seedRawBill(pool, f, o);
      const mine = await sqlPosted(bill.id);
      const theirs = await tsPosted(bill.id);
      expect(mine, `bill ${b}: ${JSON.stringify(o)}`).toEqual(theirs);
    }
  }, 180_000);
});

describe('the backfill and recordBillLinks give the same links', () => {
  it('on header-only, line-only, header + lines, fallback and excluded bills; a re-run adds nothing', async () => {
    const supplier2 = await seedSupplier(pool, f);
    const a = await seedPo(pool, f, { lines: [100, 150, 50] });
    const b = await seedPo(pool, f, { lines: [200] });
    const c = await seedPo(pool, f, { lines: [300] });
    const d = await seedPo(pool, f, { lines: [300] });
    const e = await seedPo(pool, f, { lines: [300], status: 'closed' });
    const draftPo = await seedPo(pool, f, { lines: [300], status: 'draft' });
    const stranger = await seedPo(pool, f, { lines: [300], supplier: supplier2 });
    const bills = {
      headerOnly: await seedRawBill(pool, f, { items: [{ total: 250 }], subtotal: 250, total: 287.5, header: c.po }),
      lineOnly: await seedRawBill(pool, f, { items: [{ total: 100, poItem: a.items[0] }, { total: 150, poItem: a.items[1] }, { total: 200, poItem: b.items[0] }], subtotal: 450, total: 517.5 }),
      lineAndHeader: await seedRawBill(pool, f, { items: [{ total: 100, poItem: a.items[0] }, { total: 60 }], subtotal: 160, total: 184, header: d.po }),
      grossLines: await seedRawBill(pool, f, { items: [{ total: 33.33, poItem: a.items[2] }, { total: 33.33, poItem: b.items[0] }, { total: 33.34, poItem: a.items[1] }], total: 100, subtotal: 86.96 }),
      zeroLines: await seedRawBill(pool, f, { items: [{ total: 0, poItem: e.items[0] }, { total: 80 }], subtotal: 80, total: 92 }),
      headerAlsoLined: await seedRawBill(pool, f, { items: [{ total: 70, poItem: c.items[0] }, { total: 30 }], subtotal: 100, total: 115, header: c.po }),
      draftPoOnly: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: draftPo.po }),
      strangerPo: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: stranger.po }),
      legacy: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: crypto.randomUUID() }),
      cancelled: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: c.po, status: 'cancelled' }),
      draftBill: await seedRawBill(pool, f, { items: [{ total: 40 }], subtotal: 40, total: 46, header: b.po, status: 'draft' }),
    };
    const ids = Object.values(bills).map((x) => x.id);
    const snapshot = async () => new Map((await linkRows(pool, f)).map((l) => [`${l.bill}|${l.po}`, l.amount]));

    await pool.query('SELECT purchase_order_bill_links_backfill()');
    const fromSql = await snapshot();
    const again = await pool.query('SELECT purchase_order_bill_links_backfill() AS n');
    expect(Number(again.rows[0].n)).toBe(0);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
    for (const id of ids) await inRequest(() => recordBillLinks(f.co, id, f.owner));
    const fromTs = await snapshot();

    expect(Object.fromEntries(fromTs)).toEqual(Object.fromEntries(fromSql));
    const at = (bill: { id: string }, po: { po: string }) => fromSql.get(`${bill.id}|${po.po}`);
    expect(at(bills.headerOnly, c)).toBe('250.00');
    expect(at(bills.lineOnly, a)).toBe('250.00');
    expect(at(bills.lineOnly, b)).toBe('200.00');
    expect(at(bills.lineAndHeader, a)).toBe('100.00');
    expect(at(bills.lineAndHeader, d)).toBe('60.00');           // the header-only PO: subtotal less the line-linked
    expect(at(bills.zeroLines, e)).toBe('80.00');                // lines that post nothing fall back to the subtotal, the link is kept
    expect(at(bills.headerAlsoLined, c)).toBe('70.00');          // the header PO the lines also name: the lines' amount
    // Gross-stored: a PO's amount is the SCALED posted ex-VAT (86.96 over 99.99.. of gross), never the raw line_total.
    const gross = [at(bills.grossLines, a), at(bills.grossLines, b)].map(Number);
    expect(c2(gross[0]! + gross[1]!)).toBe(86.96);
    expect(gross[1]).toBeLessThan(33.33);
    for (const none of [bills.draftPoOnly, bills.strangerPo, bills.legacy, bills.cancelled]) {
      expect([...fromSql.keys()].filter((k) => k.startsWith(none.id))).toEqual([]);
    }
    expect(at(bills.draftBill, b)).toBe('40.00');                // a draft bill is linked by the app / backfill (the MCP is what refuses it)
  });
});

describe('planBillLinks', () => {
  const l = (poId: string | null, postedCents: number) => ({ poId, postedCents });
  it('line POs get their lines; header-only and zero-posting POs share the subtotal remainder, lowest id only', () => {
    expect(planBillLinks({ subtotalCents: 10000, lines: [l('b', 3000), l('a', 2000), l(null, 5000)], headerPoId: 'z' }))
      .toEqual([{ poId: 'b', amountCents: 3000 }, { poId: 'a', amountCents: 2000 }, { poId: 'z', amountCents: 5000 }]);
    expect(planBillLinks({ subtotalCents: 10000, lines: [l('p', 0), l('q', 0)], headerPoId: null })).toEqual([{ poId: 'p', amountCents: 10000 }]);
  });
  it('never links an amount at or below zero', () => {
    expect(planBillLinks({ subtotalCents: 5000, lines: [l('a', 5000)], headerPoId: 'h' })).toEqual([{ poId: 'a', amountCents: 5000 }]);
    expect(planBillLinks({ subtotalCents: 0, lines: [l('a', 0)], headerPoId: null })).toEqual([]);
    expect(planBillLinks({ subtotalCents: 1000, lines: [], headerPoId: null })).toEqual([]);
  });
});
