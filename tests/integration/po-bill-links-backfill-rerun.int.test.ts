/**
 * Migration 1032 (the one-off re-run of purchase_order_bill_links_backfill() for every company), real PostgreSQL.
 * Two companies hold bills WITHOUT links (raw inserts: no app sync ran). The migration file's own SQL runs as the suite's `postgres`
 * inside a transaction that is ROLLED BACK (a global run must not write links into other suites' fixtures); every assertion reads inside it.
 * `evaluate(call)` returns the faults of one run; the live function must return none, and each mutant (the live function's source with one
 * clause removed, created inside the rolled-back transaction) must return some: the checks have teeth.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedRawBill, seedSupplier } from './helpers/poBillLinkHarness';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/1032_purchase_order_bill_links_backfill_rerun.sql'), 'utf8');
let a: BillFixture;
let b: BillFixture;
const bill: Record<string, { id: string; subtotal: number }> = {};
const po: Record<string, string> = {};
let expected: Record<string, string> = {};
let preB: string;
const EXISTING = ['app', 'mcp', 'mcp', 'mcp', 'mcp'];

const raw = (f: BillFixture, key: string, o: Parameters<typeof seedRawBill>[2]) =>
  seedRawBill(pool, f, o).then((r) => { bill[key] = { id: r.id, subtotal: r.subtotal }; return r; });
const lineBill = (total: number) => ({ items: [{ total }], subtotal: total, total: Math.round(total * 115) / 100 });

beforeAll(async () => {
  a = await seedBillFixture(pool, 'po-bf-rerun-a');
  b = await seedBillFixture(pool, 'po-bf-rerun-b');
  const s2 = await seedSupplier(pool, a);
  const mk = async (f: BillFixture, key: string, lines: number[], status?: string, supplier?: string) => {
    const p = await seedPo(pool, f, { lines, status, supplier });
    po[key] = p.po;
    return p;
  };
  const p1 = await mk(a, 'p1', [100]);
  const p1b = await mk(a, 'p1b', [50]);
  const p2 = await mk(a, 'p2', [60, 40]);
  const p3 = await mk(a, 'p3', [30]);
  const p4 = await mk(a, 'p4', [70], 'received');
  const p5 = await mk(a, 'p5', [100], 'draft');
  const p6 = await mk(a, 'p6', [100], 'approved', s2);
  const p7 = await mk(a, 'p7', [100]);
  const p8 = await mk(a, 'p8', [20], 'closed');
  const p9 = await mk(a, 'p9', [40]);
  const p10 = await mk(a, 'p10', [60]);
  const pb1 = await mk(b, 'pb1', [80]);
  const pb2 = await mk(b, 'pb2', [90]);
  // Company B's PO that names company A's supplier: only the company match (not the supplier match) keeps A's bill off it.
  const pbx = await mk(b, 'pbx', [10], 'approved', a.supplier);

  await raw(a, 'b1', { ...lineBill(100), header: p1.po });
  await raw(a, 'b2', { items: [{ total: 60, poItem: p2.items[0] }, { total: 40 }], subtotal: 100, total: 115 });
  await raw(a, 'b3', { items: [{ total: 70, poItem: p4.items[0] }, { total: 30 }], subtotal: 100, total: 115, header: p3.po });
  await raw(a, 'b4cancelled', { ...lineBill(10), header: p1.po, status: 'cancelled' });
  await raw(a, 'b5draftPo', { ...lineBill(10), header: p5.po });
  await raw(a, 'b6otherSupplierPo', { ...lineBill(10), header: p6.po });
  await raw(a, 'b7deleted', { ...lineBill(10), header: p1.po });
  await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bill.b7deleted!.id]);
  await raw(a, 'b8draftBill', { ...lineBill(50), header: p1b.po, status: 'draft' });
  await raw(a, 'b9held', { ...lineBill(100), header: p7.po });
  await raw(a, 'b10foreignPo', { ...lineBill(10), header: pbx.po });
  await raw(a, 'b11closedPo', { ...lineBill(20), header: p8.po });
  await raw(a, 'b12twoPos', { items: [{ total: 40, poItem: p9.items[0] }, { total: 60, poItem: p10.items[0] }], subtotal: 100, total: 115 });
  // The held and residual rules (review M2). (a) header Y, an mcp link on X that no line names: Y gets the subtotal less X's 30.
  const px = await mk(a, 'px', [100]);
  const py = await mk(a, 'py', [100]);
  await raw(a, 'bHeldA', { ...lineBill(100), header: py.po });
  // (b) a line names PP and PP carries an mcp link: the lines account for it, so held ignores it and the header PO gets 100 - 60.
  const pp = await mk(a, 'pp', [60]);
  const pyb = await mk(a, 'pyb', [100]);
  await raw(a, 'bHeldB', { items: [{ total: 60, poItem: pp.items[0] }, { total: 40 }], subtotal: 100, total: 115, header: pyb.po });
  // (c) a header PO and two zero-posting line POs all fall back: only the lowest id (byte order of its text) takes the residual.
  const ph = await mk(a, 'ph', [100]);
  const pz1 = await mk(a, 'pz1', [100]);
  const pz2 = await mk(a, 'pz2', [100]);
  await raw(a, 'bLowest', { items: [{ total: 100 }, { total: 0, poItem: pz1.items[0] }, { total: 0, poItem: pz2.items[0] }], subtotal: 100, total: 115, header: ph.po });
  await raw(b, 'bb1', { ...lineBill(80), header: pb1.po });
  await raw(b, 'bb2owned', { ...lineBill(90), header: pb2.po });
  await raw(b, 'bb3mcp', { ...lineBill(10), header: pb1.po });

  // Links that already exist, written the way their owners write them: an mcp link with a reference, a ref-less app link.
  await pool.query(
    `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref)
     VALUES ($1, $2, $3, 100, 'mcp', 'sage', 'REF-9')`, [a.co, p7.po, bill.b9held!.id]);
  await pool.query(
    `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 90, 'app')`,
    [b.co, pb2.po, bill.bb2owned!.id]);
  await pool.query(
    `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref)
     VALUES ($1, $2, $3, 10, 'mcp', 'sage', 'REF-10')`, [b.co, pb1.po, bill.bb3mcp!.id]);

  for (const [bk, pk, amount, ref] of [['bHeldA', 'px', 30, 'REF-A'], ['bHeldB', 'pp', 60, 'REF-B']] as const) {
    await pool.query(
      `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref)
       VALUES ($1, $2, $3, $4, 'mcp', 'sage', $5)`, [a.co, po[pk], bill[bk]!.id, amount, ref]);
  }
  const lowest = ['ph', 'pz1', 'pz2'].map((k) => po[k]!).sort((x, y) => (x < y ? -1 : 1))[0]!;

  const key = (x: string, y: string) => `${bill[x]!.id}|${po[y]!}`;
  expected = {
    [key('b1', 'p1')]: '100.00', [key('b2', 'p2')]: '60.00', [key('b3', 'p4')]: '70.00', [key('b3', 'p3')]: '30.00',
    [key('b8draftBill', 'p1b')]: '50.00', [key('b11closedPo', 'p8')]: '20.00', [key('b12twoPos', 'p9')]: '40.00', [key('b12twoPos', 'p10')]: '60.00',
    [key('bb1', 'pb1')]: '80.00', [key('bHeldA', 'py')]: '70.00', [key('bHeldB', 'pyb')]: '40.00', [`${bill.bLowest!.id}|${lowest}`]: '100.00',
    [key('bHeldA', 'px')]: '30.00', [key('bHeldB', 'pp')]: '60.00',
    // What was there before the run, unchanged:
    [key('b9held', 'p7')]: '100.00', [key('bb2owned', 'pb2')]: '90.00', [key('bb3mcp', 'pb1')]: '10.00',
  };
  preB = JSON.stringify(await rowsOf(pool, [b.co]));
}, 120_000);
afterAll(async () => {
  try { for (const f of [a, b]) await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

type Q = Pick<PoolClient, 'query'> | Pool;
const rowsOf = async (q: Q, cos: string[]) => (await q.query(
  `SELECT id, company_id, purchase_order_id AS po, supplier_invoice_id AS bill, amount::TEXT AS amount, source, external_system, external_ref, created_at::TEXT AS at
     FROM purchase_order_bill_links WHERE company_id = ANY($1::UUID[]) ORDER BY purchase_order_id, supplier_invoice_id`, [cos])).rows;

/** Runs `call` twice in a transaction that is rolled back; returns every way the outcome departs from the rules. */
async function evaluate(setup: string | null, call: string): Promise<string[]> {
  const faults: string[] = [];
  const c = await pool.connect();
  const notes: string[] = [];
  const onNotice = (n: { message?: string }) => { notes.push(String(n.message)); };
  c.on('notice', onNotice);
  try {
    await c.query('BEGIN');
    if (setup) await c.query(setup);
    const before = await rowsOf(c, [a.co, b.co]);
    if (before.length !== EXISTING.length) faults.push(`setup: ${before.length} links before the run, expected the ${EXISTING.length} existing`);
    try { await c.query(call); } catch (e) { faults.push(`first run threw: ${(e as Error).message}`); return faults; }
    const mine = new Set(Object.values(bill).map((x) => x.id));
    for (const n of notes) if ([...mine].some((id) => n.includes(id))) faults.push(`a fixture bill was skipped: ${n.slice(0, 120)}`);
    const rows = await rowsOf(c, [a.co, b.co]);
    const got = Object.fromEntries(rows.map((r) => [`${r.bill}|${r.po}`, r.amount]));
    const names = new Map<string, string>([...Object.entries(bill).map(([n, v]) => [v.id, n] as const), ...Object.entries(po).map(([n, v]) => [v, n] as const)]);
    const label = (k: string) => k.split('|').map((id) => names.get(id) ?? id).join('->');
    for (const k of new Set([...Object.keys(expected), ...Object.keys(got)])) {
      if (expected[k] !== got[k]) faults.push(`link ${label(k)}: expected ${expected[k] ?? 'none'}, got ${got[k] ?? 'none'}`);
    }
    for (const [name, x] of Object.entries(bill)) {
      const sum = rows.filter((r) => r.bill === x.id).reduce((s, r) => s + Number(r.amount), 0);
      if (sum > x.subtotal + 0.005) faults.push(`bill ${name}: links ${sum} exceed its subtotal ${x.subtotal}`);
    }
    const cross = (await c.query(
      `SELECT count(*)::INT AS n FROM purchase_order_bill_links l JOIN purchase_orders p ON p.id = l.purchase_order_id JOIN supplier_invoices s ON s.id = l.supplier_invoice_id
        WHERE l.company_id = ANY($1::UUID[]) AND (p.company_id <> l.company_id OR s.company_id <> l.company_id OR p.supplier_id <> s.supplier_id)`, [[a.co, b.co]])).rows[0].n;
    if (cross) faults.push(`${cross} link(s) join another company's or supplier's rows`);
    const preExisting = rows.filter((r) => r.source !== 'backfill').map((r) => r.id).sort().join();
    if (preExisting !== before.map((r) => r.id).sort().join()) faults.push('a pre-existing link was changed or replaced');
    if (JSON.stringify(await rowsOf(c, [b.co]).then((r) => r.filter((x) => x.source !== 'backfill'))) !== preB) faults.push("the other company's pre-existing links changed");
    const locks = (await c.query(
      `SELECT DISTINCT mode FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation' AND mode NOT IN ('AccessShareLock', 'RowShareLock', 'RowExclusiveLock')`)).rows;
    if (locks.length) faults.push(`table lock(s) above ROW EXCLUSIVE held: ${locks.map((l) => l.mode).join(', ')}`);
    notes.length = 0;
    try { await c.query(call); } catch (e) { faults.push(`second run threw: ${(e as Error).message}`); return faults; }
    const again = await rowsOf(c, [a.co, b.co]);
    if (JSON.stringify(again) !== JSON.stringify(rows)) faults.push('the second run changed links');
    // The second run writes nothing for these companies (their rows above are identical, none skipped); a notice's global count would also count
    // a concurrent suite's rows, which is not this migration's business.
    for (const n of notes) if ([...mine].some((id) => n.includes(id))) faults.push(`a fixture bill was skipped on the second run: ${n.slice(0, 120)}`);
    return faults;
  } finally {
    c.off('notice', onNotice);
    try { await c.query('ROLLBACK'); } finally { c.release(); }
  }
}

const HELD_LINES_CLAUSE = `
                        -- 1022 (PR #1703, breaker BRK-B): not a link of a PO the bill's lines name: the lines account for it.
                        AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                                         WHERE x.supplier_invoice_id = si.id AND pi.purchase_order_id = l.purchase_order_id)`;
const live = async () => String((await pool.query(`SELECT prosrc FROM pg_proc WHERE oid = 'public.purchase_order_bill_links_backfill(uuid)'::regprocedure`)).rows[0].prosrc);
const mutant = (src: string, from: string, to: string) => {
  expect(src.split(from).length - 1, `the live function contains ${JSON.stringify(from)} once`).toBe(1);
  return `CREATE FUNCTION public.bf_mutant(p_company UUID DEFAULT NULL) RETURNS BIGINT LANGUAGE plpgsql SECURITY INVOKER
          SET search_path = pg_catalog, public, pg_temp AS $mut$${src.replace(from, to)}$mut$`;
};

describe('migration 1032 over two companies of unlinked bills', () => {
  it('the migration file is one backfill call with bounded waits and no DDL', () => {
    expect(MIGRATION).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(MIGRATION).toMatch(/SET LOCAL statement_timeout = '\d+s';/);
    expect(MIGRATION.match(/^\s*SELECT\s+public\.purchase_order_bill_links_backfill\(\);\s*$/gm)?.length).toBe(1);
    expect(MIGRATION.replace(/--.*$/gm, '')).not.toMatch(/\b(CREATE|ALTER|DROP|LOCK|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it('starts with no backfill link in either company', async () => {
    expect((await rowsOf(pool, [a.co, b.co])).map((r) => r.source).sort()).toEqual(EXISTING);
  });

  it('links exactly where the rules say, writes nothing the second time, keeps every bill within its subtotal and every other row as it was', async () => {
    expect(await evaluate(null, MIGRATION)).toEqual([]);
  }, 60_000);

  it('the backfill left no row behind (the run was rolled back)', async () => {
    expect((await rowsOf(pool, [a.co, b.co])).filter((r) => r.source === 'backfill')).toEqual([]);
  });
});

describe('the checks have teeth: each mutant of the live function is caught', () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ['no ON CONFLICT (not idempotent)', 'ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING', '', /threw/],
    ['no company match', 'pr.po_company = pr.company_id AND ', '', /skipped/],
    ['no supplier match', ' AND pr.po_supplier = pr.supplier_id', '', /skipped/],
    ['any PO status', "AND pr.po_status IN ('approved', 'partially_received', 'received', 'closed')", '', /expected none/],
    ['cancelled bills too', "si.status <> 'cancelled' AND ", '', /expected none/],
    ['deleted bills too', 'AND si.deleted_at IS NULL', '', /expected none/],
    ['a table lock above ROW EXCLUSIVE', '  FOR r IN\n', '  LOCK TABLE public.purchase_order_bill_links IN SHARE ROW EXCLUSIVE MODE;\n  FOR r IN\n', /table lock/],
    ['header residual ignores the lines', ' - s.pos_total', '', /exceed its subtotal|bLowest|expected 30\.00/],
    ['header residual ignores the mcp links held', ' - s.held_c', '', /bHeldA|bHeldB/],
    ['held counts a link of a PO the lines name', HELD_LINES_CLAUSE, '', /bHeldB/],
    ['held counts the links the writer owns, not the others', "AND NOT (l.source IN ('app', 'backfill') AND l.external_ref IS NULL)", "AND (l.source IN ('app', 'backfill') AND l.external_ref IS NULL)", /bHeldA|bHeldB/],
    ['the residual goes to the highest id, not the lowest', 'MIN(pt.po::TEXT COLLATE "C")', 'MAX(pt.po::TEXT COLLATE "C")', /bLowest/],
  ];
  it.each(cases)('%s', async (_name, from, to, caught) => {
    const faults = await evaluate(mutant(await live(), from, to), 'SELECT public.bf_mutant()');
    expect(faults.length, 'the mutant is not caught').toBeGreaterThan(0);
    expect(faults.join(' | ')).toMatch(caught);
  }, 60_000);
});

describe('known limit (design note, limit 2): a stale link beside a re-pointed header is not repaired', () => {
  let m: BillFixture;
  beforeAll(async () => { m = await seedBillFixture(pool, 'po-bf-rerun-limit'); }, 60_000);
  afterAll(async () => { await dropBillFixture(pool, m); }, 60_000);

  it('the function today links header PO B beside the stale backfill link to A: 200.00 on a 100.00 bill (pinned, not endorsed)', async () => {
    const poA = await seedPo(pool, m, { lines: [100] });
    const poB = await seedPo(pool, m, { lines: [100] });
    const stale = await seedRawBill(pool, m, { items: [{ total: 100 }], subtotal: 100, total: 115, header: poB.po });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // The stale link: written by an earlier backfill while the header named A, then the header was re-pointed to B outside the app.
      await c.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'backfill')`, [m.co, poA.po, stale.id]);
      const sql = /```sql\n([\s\S]*?)```/.exec(readFileSync(join(process.cwd(), 'docs/design/po-bill-links-backfill.md'), 'utf8'))?.[1];
      expect(sql, 'the design note carries the count query').toBeDefined();
      const count = async () => (await c.query(`SELECT * FROM (${sql!.replace(/;\s*$/, '')}) q WHERE q.company_id = $1`, [m.co])).rows;
      expect(await count(), 'the note\'s query finds the bill before the run').toEqual([{ company_id: m.co, bills: '1' }]);
      await c.query('SELECT purchase_order_bill_links_backfill($1)', [m.co]);
      const links = (await c.query('SELECT purchase_order_id AS po, amount::TEXT AS amount FROM purchase_order_bill_links WHERE supplier_invoice_id = $1 ORDER BY amount, purchase_order_id', [stale.id])).rows;
      expect(links.map((l) => [l.po, l.amount]).sort()).toEqual([[poA.po, '100.00'], [poB.po, '100.00']].sort());
      expect(await count(), 'and no longer once B is linked').toEqual([]);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  }, 60_000);
});
