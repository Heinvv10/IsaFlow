/**
 * Migration 1022: the counter, re-runs, the per-order guard and the retired tables' write rules, real PostgreSQL 16.
 *   - the purchase_order counter: raised past a copied number of its form, never moved back, inserted when the company has
 *     none, a custom prefix honoured, a non-numeric number ignored; each company to itself;
 *   - a re-run changes nothing; after a new legacy row is seeded only that row copies;
 *   - an order an unforeseen constraint refuses is skipped (WARNING), the rest still copy;
 *   - a role that does not bypass row security is refused before anything changes (it would see no rows and "copy 0");
 *   - the triggers: INSERT / UPDATE refused, DELETE allowed (the copies are independent orders the app edits and deletes),
 *     ENABLE ALWAYS so replica mode does not switch them off.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { asBeforeRetirement, canonicalSnapshot, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo, type SpoLine } from './spo-retire-1022.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
let g: BillFixture;
const S: Record<string, SeededSpo> = {};
const retired = /retired.*use purchase_orders/;

const counter = async (co: string) => (await pool.query(
  `SELECT prefix, next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'purchase_order'`, [co])).rows;
const poOf = async (id: string) => (await pool.query('SELECT company_id, po_number FROM purchase_orders WHERE id = $1', [id])).rows[0];
const seed = (fx: BillFixture, number: string, lines: SpoLine[] = [{ qty: 1, price: 10 }]) =>
  asBeforeRetirement(pool, (c) => seedSpo(c, { co: fx.co, supplier: fx.supplier, number, status: 'draft', lines }));
const companies = () => [f.co, other.co, g.co];

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-guards');
  other = await seedBillFixture(pool, 'spo-guards-other');
  g = await seedBillFixture(pool, 'spo-guards-g');
  await pool.query(`INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
                    VALUES ($1, 'purchase_order', 'PO', 5, 7), ($2, 'purchase_order', 'ORD-', 500, 7)`, [f.co, g.co]);
  await asBeforeRetirement(pool, async (c) => {
    const at = async (k: string, fx: BillFixture, number: string) => {
      S[k] = await seedSpo(c, { co: fx.co, supplier: fx.supplier, number, status: 'draft', lines: [{ qty: 1, price: 10 }, { qty: 2, price: 3 }] });
    };
    await at('fCanon', f, 'PO0000042');
    await at('fSame', f, 'SAME-1');
    await at('oCanon', other, 'PO0000007');
    await at('oDash', other, 'PO-12');
    await at('oSame', other, 'SAME-1');
    await at('gBelow', g, 'ORD-0000042');
    await at('gAlpha', g, 'ORD-12AB');
    await at('gOther', g, 'PO0000999');
  });
  await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f && other && g) { await dropLegacy(pool, companies()); await dropCanonical(pool, companies()); }
    for (const x of [f, other, g]) await dropBillFixture(pool, x);
  } finally { await pool.end(); }
}, 60_000);

describe('the counter and the companies', () => {
  it('raises the counter past a copied number of its own form', async () => {
    expect(await counter(f.co)).toEqual([{ prefix: 'PO', next_number: 43 }]);
  });
  it('inserts a counter for a company that has none, ignoring a number not of its form', async () => {
    expect(await counter(other.co)).toEqual([{ prefix: 'PO', next_number: 8 }]);
  });
  it('honours a custom prefix and never moves the counter back', async () => {
    expect(await counter(g.co)).toEqual([{ prefix: 'ORD-', next_number: 500 }]);
  });
  it('copies the same number into each company, unrenamed', async () => {
    expect(await poOf(S.fSame!.id)).toEqual({ company_id: f.co, po_number: 'SAME-1' });
    expect(await poOf(S.oSame!.id)).toEqual({ company_id: other.co, po_number: 'SAME-1' });
  });
});

describe('re-runs and the per-order guard', () => {
  it('a re-run changes nothing', async () => {
    const before = await canonicalSnapshot(pool, companies());
    const notices = await runMigration(pool);
    expect(await canonicalSnapshot(pool, companies())).toBe(before);
    expect(notices).toContain('1022: copied 0 order(s) in all, 0 skipped, 0 renamed, 0 closed, 0 line(s) as 1 unit');
  });

  it('after a new legacy row is seeded, a re-run copies only that row', async () => {
    const before = await canonicalSnapshot(pool, companies());
    S.late = await seed(f, 'LATE-1');
    const notices = await runMigration(pool);
    expect(notices).toContain('1022: copied 1 order(s) in all, 0 skipped, 0 renamed, 0 closed, 0 line(s) as 1 unit');
    expect(await poOf(S.late.id)).toEqual({ company_id: f.co, po_number: 'LATE-1' });
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [S.late.id]);
    await pool.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [S.late.id]); // DELETE is allowed
    expect(await canonicalSnapshot(pool, companies())).toBe(before);
  });

  // Review M1: only the four intended shapes are skipped. An order the database refuses (an unforeseen constraint, an overflow)
  // fails the migration, so the legacy tables stay writable and nothing is hidden behind a green release.
  const refused = async (number: string, lines: SpoLine[], sqlstate: string) => {
    const row = await seed(f, number, lines);
    const beside = await seed(f, `${number}-BESIDE`);
    const before = await canonicalSnapshot(pool, companies());
    const trig = (await pool.query(`SELECT pg_get_functiondef('supplier_purchase_orders_retired()'::regprocedure) AS d`)).rows[0].d;
    const err = await runMigration(pool).then(() => null, (e: Error & { notices?: string[] }) => e);
    expect(err?.message).toMatch(/1022: 1 order\(s\) refused by the database/);
    expect(err?.notices?.some((n) => n.includes(row.id) && n.includes(`refused by the database (${sqlstate})`))).toBe(true);
    expect(await poOf(row.id)).toBeUndefined();
    expect(await poOf(beside.id)).toBeUndefined();
    expect(await canonicalSnapshot(pool, companies())).toBe(before);
    expect((await pool.query(`SELECT pg_get_functiondef('supplier_purchase_orders_retired()'::regprocedure) AS d`)).rows[0].d).toBe(trig);
    await pool.query('DELETE FROM supplier_purchase_orders WHERE id = ANY($1::UUID[])', [[row.id, beside.id]]);
  };

  it('fails the whole migration (nothing copied) when the database refuses an order: a constraint', async () => {
    await pool.query(`ALTER TABLE purchase_orders ADD CONSTRAINT spo_1022_forced CHECK (po_number <> 'FORCE-1') NOT VALID`);
    try { await refused('FORCE-1', [{ qty: 1, price: 10 }], '23514'); } finally {
      await pool.query('ALTER TABLE purchase_orders DROP CONSTRAINT spo_1022_forced');
    }
  });

  it('fails the whole migration when a price overflows po_items (numeric_value_out_of_range)', async () => {
    await refused('OVERFLOW-1', [{ qty: 0.01, price: 0, lineTotal: 1_000_000_000_000 }], '22003');
  });
});

describe('the retired tables\' write rules', () => {
  const asApp = async (sqlText: string, params: unknown[]) => {
    const req = await openRequest(pool, f, f.owner);
    try { await req.client.query(sqlText, params); } finally { await req.rollback(); }
  };
  const asOwner = async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
  };

  it('refuses an insert and an update, as app_user, on both tables', async () => {
    await expect(asApp(`INSERT INTO supplier_purchase_orders (company_id, order_number, supplier_id) VALUES ($1, 'NEW-1', $2)`, [f.co, f.supplier])).rejects.toThrow(retired);
    await expect(asApp(`UPDATE supplier_purchase_orders SET notes = 'x' WHERE id = $1`, [S.fSame!.id])).rejects.toThrow(retired);
    await expect(asApp(`INSERT INTO supplier_purchase_order_items (purchase_order_id, description) VALUES ($1, 'x')`, [S.fSame!.id])).rejects.toThrow(retired);
    await expect(asApp(`UPDATE supplier_purchase_order_items SET description = 'x' WHERE id = $1`, [S.fSame!.items[0]])).rejects.toThrow(retired);
  });

  it('allows DELETE as app_user: a copied order (the cascade takes its lines), one with no copy at all, a lone line', async () => {
    const lone = await seed(f, 'LONE-1');
    await asOwner(async (c) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)", [JSON.stringify({ sub: f.owner }), f.co]);
      expect((await c.query('DELETE FROM supplier_purchase_order_items WHERE id = $1', [lone.items[0]])).rowCount).toBe(1);
      expect((await c.query('DELETE FROM supplier_purchase_orders WHERE id = ANY($1::UUID[])', [[S.fSame!.id, lone.id]])).rowCount).toBe(2);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT count(*)::INT AS n FROM supplier_purchase_order_items WHERE purchase_order_id = $1', [S.fSame!.id])).rows[0].n).toBe(0);
    });
  });

  it('refuses the migration, before it changes anything, for a role that does not bypass row security', async () => {
    const before = (await pool.query(`SELECT pg_get_functiondef('supplier_purchase_orders_retired()'::regprocedure) AS d`)).rows[0].d;
    await expect(runMigration(pool, 'app_user')).rejects.toThrow(/1022 must run as a role that bypasses row security/);
    expect((await pool.query(`SELECT pg_get_functiondef('supplier_purchase_orders_retired()'::regprocedure) AS d`)).rows[0].d).toBe(before);
  });

  it('leaves both triggers ENABLE ALWAYS, on INSERT and UPDATE only', async () => {
    const rows = (await pool.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('supplier_purchase_orders'::regclass, 'supplier_purchase_order_items'::regclass) ORDER BY tgname`)).rows;
    expect(rows.map((r) => [r.tgname, r.tgenabled])).toEqual([['trg_supplier_purchase_order_items_retired', 'A'], ['trg_supplier_purchase_orders_retired', 'A']]);
    for (const r of rows) expect(r.def).toMatch(/BEFORE INSERT OR UPDATE ON/);
  });

  it('refuses for every session: session_replication_role = replica does not switch the triggers off', async () => {
    await expect(asOwner(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE supplier_purchase_orders SET notes = 'x' WHERE id = $1`, [S.oSame!.id]);
    })).rejects.toThrow(retired);
  });
});
