/**
 * purchase_order_bill_links_backfill() over hostile data (review round 4), real PostgreSQL. It runs in the migration and again after
 * the release, so it must never throw and never link what the table's own guard refuses:
 *   - adversarial shapes: a header naming another company's PO, a PO with no company, another supplier's PO, a legacy
 *     supplier_purchase_orders id, a cancelled / draft / submitted PO, lines naming po_items of such POs, a cancelled or soft-deleted
 *     bill, a bill with nothing to link: no error, no link, while a valid bill beside them is linked;
 *   - a row that changes UNDER the run: the guard and the FK read other snapshots than the statement that chose the row, so a PO deleted
 *     by a transaction that commits mid-run used to abort the whole call with the guard's / the FK's error; now that row alone is
 *     skipped (a WARNING) and the rest are still linked;
 *   - `purchase_order_bill_links_backfill(company)` touches that company's bills only (other suites' data, other tenants' too, are left).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedBill, seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-backfill');
  other = await seedBillFixture(pool, 'po-links-backfill-other');
}, 60_000);
afterAll(async () => {
  try { for (const x of [f, other]) await dropBillFixture(pool, x); } finally { await pool.end(); }
}, 60_000);

const backfill = async (company: string) => Number((await pool.query('SELECT purchase_order_bill_links_backfill($1) AS n', [company])).rows[0].n);
const header = (bill: string, po: string) => pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill, po]);

describe('the backfill over adversarial data', () => {
  it('links the valid bill and neither throws nor links any of the hostile shapes', async () => {
    const supplier2 = await seedSupplier(pool, f);
    const good = await seedPo(pool, f, { lines: [100] });
    const theirs = await seedPo(pool, other, { lines: [100] });
    const strangers = await seedPo(pool, f, { lines: [100], supplier: supplier2 });
    const cancelled = await seedPo(pool, f, { lines: [100], status: 'cancelled' });
    const draftPo = await seedPo(pool, f, { lines: [100], status: 'draft' });
    const submitted = await seedPo(pool, f, { lines: [100], status: 'submitted' });
    // A PO with no company at all (the column is nullable), with a line.
    const orphanPo = crypto.randomUUID();
    const orphanItem = crypto.randomUUID();
    await pool.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, status, subtotal, total) VALUES ($1, NULL, $2, $3, 'approved', 100, 100)`, [orphanPo, `ORPHAN-${orphanPo.slice(0, 6)}`, f.supplier]);
    await pool.query(`INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total) VALUES ($1, $2, 'x', 1, 100, 100)`, [orphanItem, orphanPo]);
    const legacy = crypto.randomUUID();
    await pool.query(`INSERT INTO supplier_purchase_orders (id, company_id, order_number, supplier_id, status) VALUES ($1, $2, 'LEGACY-1', $3, 'sent')`, [legacy, f.co, f.supplier]);

    const valid = await seedRawBill(pool, f, { items: [{ total: 100 }], subtotal: 100, total: 115, header: good.po });
    const hostile = {
      foreignHeader: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: theirs.po }),
      orphanHeader: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: orphanPo }),
      strangerHeader: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: strangers.po }),
      legacyHeader: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: legacy }),
      unknownHeader: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: crypto.randomUUID() }),
      cancelledPo: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: cancelled.po }),
      draftPo: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: draftPo.po }),
      submittedPo: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: submitted.po }),
      linesForeign: await seedRawBill(pool, f, { items: [{ total: 10, poItem: theirs.items[0] }], subtotal: 10, total: 11.5 }),
      linesOrphan: await seedRawBill(pool, f, { items: [{ total: 10, poItem: orphanItem }], subtotal: 10, total: 11.5 }),
      linesStranger: await seedRawBill(pool, f, { items: [{ total: 10, poItem: strangers.items[0] }], subtotal: 10, total: 11.5 }),
      linesCancelled: await seedRawBill(pool, f, { items: [{ total: 10, poItem: cancelled.items[0] }], subtotal: 10, total: 11.5 }),
      linesDraft: await seedRawBill(pool, f, { items: [{ total: 10, poItem: draftPo.items[0] }], subtotal: 10, total: 11.5 }),
      cancelledBill: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: good.po, status: 'cancelled' }),
      deletedBill: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: good.po }),
      otherSupplierBill: await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5, header: good.po, supplier: supplier2 }),
      emptyBill: await seedRawBill(pool, f, { items: [], subtotal: 0, total: 0, header: good.po }),
    };
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [hostile.deletedBill.id]);

    let made = -1;
    await expect((async () => { made = await backfill(f.co); })()).resolves.toBeUndefined();
    const rows = await linkRows(pool, f);
    expect(rows.map((r) => [r.bill, r.po, r.amount])).toEqual([[valid.id, good.po, '100.00']]);
    expect(made).toBe(1);
    expect(await backfill(f.co)).toBe(0);
    // Another company's PO line is not this company's either way round: nothing was written for the other company.
    expect(await linkRows(pool, other)).toEqual([]);
    await pool.query('DELETE FROM po_items WHERE id = $1', [orphanItem]);
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [orphanPo]);
    await pool.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [legacy]);
  });

  it('with a company it touches that company only', async () => {
    const mine = await seedPo(pool, f, { lines: [10] });
    const theirs = await seedPo(pool, other, { lines: [10] });
    const myBill = await seedBill(pool, f, { lines: [10] });
    const theirBill = await seedBill(pool, other, { lines: [10] });
    await header(myBill.id, mine.po);
    await header(theirBill.id, theirs.po);
    await backfill(f.co);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${myBill.id}'`)).length).toBe(1);
    expect(await linkRows(pool, other, `l.supplier_invoice_id = '${theirBill.id}'`)).toEqual([]);
    await backfill(other.co);
    expect((await linkRows(pool, other, `l.supplier_invoice_id = '${theirBill.id}'`)).length).toBe(1);
  });
});

describe('a row that changes under the run', () => {
  it('a PO deleted by a transaction that commits while the backfill waits on it (guard and FK read other snapshots) skips that row only: no throw, the others are linked', async () => {
    const doomed = await seedPo(pool, f, { lines: [10] });
    const kept = await seedPo(pool, f, { lines: [10] });
    const doomedBill = await seedBill(pool, f, { lines: [10] });
    const keptBill = await seedBill(pool, f, { lines: [10] });
    await header(doomedBill.id, doomed.po);
    await header(keptBill.id, kept.po);
    // The deleter holds the PO's row lock with its delete not yet committed: the backfill's statement still sees the PO, and its insert
    // waits on the PO row (the FK check) until the delete commits, then finds the PO gone. No DDL: nothing is shared with other suites.
    const deleter = await pool.connect();
    try {
      await deleter.query('BEGIN');
      await deleter.query('DELETE FROM po_items WHERE purchase_order_id = $1', [doomed.po]);
      await deleter.query('DELETE FROM purchase_orders WHERE id = $1', [doomed.po]);
      const run = backfill(f.co);
      await new Promise((r) => setTimeout(r, 700));
      await deleter.query('COMMIT');
      expect(await run).toBe(1);
    } finally { deleter.release(); }
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${keptBill.id}'`)).length).toBe(1);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${doomedBill.id}'`)).toEqual([]);
  }, 60_000);
});

describe('the backfill\'s plan does not grow with bills x POs', () => {
  const POS = 300;
  const BILLS = 600;
  let s: BillFixture;
  beforeAll(async () => {
    s = await seedBillFixture(pool, 'po-links-backfill-scale');
    const pos = [];
    // ONE supplier with many POs: the shape that made the plan quadratic (a bill joined to every PO of its supplier).
    for (let i = 0; i < POS; i++) pos.push(await seedPo(pool, s, { lines: [10 + (i % 40)] }));
    for (let i = 0; i < BILLS; i++) {
      await seedRawBill(pool, s, { items: [{ total: 10 + (i % 40), poItem: i % 2 === 0 ? pos[i % POS]!.items[0] : null }], subtotal: 10 + (i % 40),
        total: Math.round((10 + (i % 40)) * 115) / 100, header: pos[(i + 7) % POS]!.po });
    }
    for (const t of ['supplier_invoices', 'supplier_invoice_items', 'purchase_orders', 'po_items']) await pool.query(`ANALYZE ${t}`);
  }, 120_000);
  afterAll(async () => { await dropBillFixture(pool, s); }, 60_000);

  it('po_bill_posted_cents runs once per candidate bill, however many POs the supplier has (it was bills x POs)', async () => {
    const c = await pool.connect();
    let calls = -1;
    let linked = -1;
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL track_functions = 'all'");
      linked = Number((await c.query('SELECT purchase_order_bill_links_backfill($1) AS n', [s.co])).rows[0].n);
      calls = Number((await c.query(`SELECT COALESCE(pg_stat_get_xact_function_calls('public.po_bill_posted_cents(uuid)'::regprocedure), 0) AS n`)).rows[0].n);
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(linked).toBeGreaterThanOrEqual(BILLS);
    expect(calls).toBeGreaterThan(0);
    expect(calls, 'one call per candidate bill, not per (bill, PO)').toBeLessThanOrEqual(BILLS);
  }, 120_000);

  it('no node of the backfill\'s query handles more than 4 x (bills + POs) rows: the cand x purchase_orders join (bills x POs) of the old plan is what this catches', async () => {
    // The LIVE function's own SELECT (its body from pg_proc, between FOR r IN and LOOP) with the company filled in, EXPLAIN ANALYZEd: a later
    // migration that replaces the function is tested, not 1006's file text.
    const fn = String((await pool.query(`SELECT prosrc FROM pg_proc WHERE oid = 'public.purchase_order_bill_links_backfill(uuid)'::regprocedure`)).rows[0].prosrc);
    const query = fn.slice(fn.indexOf('FOR r IN') + 'FOR r IN'.length, fn.indexOf('  LOOP')).replace(/p_company/g, `'${s.co}'::UUID`);
    const text = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON) ${query}`)).rows[0]['QUERY PLAN']);
    expect(text, 'the NOT IN of the header-only branch is hashed').toContain('hashed SubPlan');
    const plan = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`)).rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    let worst = 0;
    const walk = (n: Record<string, unknown>) => {
      worst = Math.max(worst, Number(n['Actual Rows']) * Number(n['Actual Loops']));
      for (const c of (n.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
    };
    walk(plan);
    expect(worst, `the widest plan node handled ${worst} rows`).toBeLessThanOrEqual(4 * (BILLS + POS));
  }, 120_000);
});
