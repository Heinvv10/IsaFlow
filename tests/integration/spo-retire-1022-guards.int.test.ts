/**
 * Migration 1022: the counter, re-runs, the per-order guard and the retired tables' write rules, real PostgreSQL 16.
 *   - the purchase_order counter: raised past a copied number of its form, never moved back, inserted when the company has
 *     none, a custom prefix honoured, a non-numeric number ignored; each company to itself;
 *   - a re-run changes nothing; after a new legacy row is seeded only that row copies;
 *   - an order an unforeseen constraint refuses is skipped (WARNING, skips record), the rest still copy;
 *   - the triggers: INSERT / UPDATE refused, DELETE by state (copy in the same company, or skipped; a line by its header, the
 *     cascade), TRUNCATE refused, replica mode does not switch them off; as app_user and as the owner.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, canonicalSnapshot, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';

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
const seed = (fx: BillFixture, number: string, lines = [{ qty: 1, price: 10 }]) =>
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
    expect(notices).toContain('1022: copied 0 order(s) in all, 0 skipped, 0 renamed, 0 closed for billing evidence, 0 line(s) as 1 unit');
  });

  it('after a new legacy row is seeded, a re-run copies only that row', async () => {
    const before = await canonicalSnapshot(pool, companies());
    S.late = await seed(f, 'LATE-1');
    const notices = await runMigration(pool);
    expect(notices).toContain('1022: copied 1 order(s) in all, 0 skipped, 0 renamed, 0 closed for billing evidence, 0 line(s) as 1 unit');
    expect(await poOf(S.late.id)).toEqual({ company_id: f.co, po_number: 'LATE-1' });
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [S.late.id]);
    expect(await canonicalSnapshot(pool, companies())).toBe(before);
  });

  it('skips an order a constraint refuses (WARNING, a skips record) and still copies the others', async () => {
    S.forced = await seed(f, 'FORCE-1');
    S.beside = await seed(f, 'BESIDE-1');
    await pool.query(`ALTER TABLE purchase_orders ADD CONSTRAINT spo_1022_forced CHECK (po_number <> 'FORCE-1') NOT VALID`);
    let notices: string[];
    try { notices = await runMigration(pool); } finally { await pool.query('ALTER TABLE purchase_orders DROP CONSTRAINT spo_1022_forced'); }
    expect(await poOf(S.forced.id)).toBeUndefined();
    expect(await poOf(S.beside.id)).toEqual({ company_id: f.co, po_number: 'BESIDE-1' });
    expect(notices.some((n) => n.includes(S.forced!.id) && n.includes('refused by the database (23514)'))).toBe(true);
    expect(notices).toContain('1022: skipped per reason: 0 supplier of another company, 0 negative line total, 0 line id already in po_items, '
      + '0 id already a purchase order of another company, 1 refused by the database');
    const rec = (await pool.query('SELECT reason FROM supplier_purchase_orders_retired_skips WHERE id = $1', [S.forced.id])).rows;
    expect(rec[0]?.reason).toMatch(/^refused by the database \(23514\)/);
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

  it('deletes a copied order as app_user, and the cascade takes its lines', async () => {
    await asOwner(async (c) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)", [JSON.stringify({ sub: f.owner }), f.co]);
      expect((await c.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [S.fSame!.id])).rowCount).toBe(1);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT count(*)::INT AS n FROM supplier_purchase_order_items WHERE purchase_order_id = $1', [S.fSame!.id])).rows[0].n).toBe(0);
    });
  });

  it('deletes a skipped order and its lines', async () => {
    await asOwner(async (c) => {
      expect((await c.query('DELETE FROM supplier_purchase_order_items WHERE purchase_order_id = $1', [S.forced!.id])).rowCount).toBe(1);
      expect((await c.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [S.forced!.id])).rowCount).toBe(1);
    });
  });

  it('refuses the delete of an order with no copy and no skip record, and of its lines', async () => {
    const lone = await seed(f, 'LONE-1');
    await expect(asOwner((c) => c.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [lone.id]))).rejects.toThrow(retired);
    await expect(asOwner((c) => c.query('DELETE FROM supplier_purchase_order_items WHERE id = $1', [lone.items[0]]))).rejects.toThrow(retired);
  });

  it('refuses the delete when the same id is a purchase order of ANOTHER company', async () => {
    const twin = await seed(f, 'TWIN-1');
    await pool.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id) VALUES ($1, $2, 'TWIN-THEIRS', $3)`, [twin.id, other.co, other.supplier]);
    await expect(asOwner((c) => c.query('DELETE FROM supplier_purchase_orders WHERE id = $1', [twin.id]))).rejects.toThrow(retired);
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [twin.id]);
  });

  it('refuses the delete of a line whose id is a po_items row of a different order, when its own header has no copy', async () => {
    const orphan = await seed(f, 'ORPHAN-1');
    const po = await seedPo(pool, f, { lines: [] });
    await pool.query(`INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total) VALUES ($1, $2, 'x', 1, 1, 1)`,
      [orphan.items[0], po.po]);
    await expect(asOwner((c) => c.query('DELETE FROM supplier_purchase_order_items WHERE id = $1', [orphan.items[0]]))).rejects.toThrow(retired);
  });

  it('refuses TRUNCATE on both tables', async () => {
    await expect(asOwner((c) => c.query('TRUNCATE supplier_purchase_order_items'))).rejects.toThrow(/TRUNCATE is refused/);
    await expect(asOwner((c) => c.query('TRUNCATE supplier_purchase_orders CASCADE'))).rejects.toThrow(/TRUNCATE is refused/);
  });

  it('refuses for every session: session_replication_role = replica does not switch the triggers off', async () => {
    await expect(asOwner(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE supplier_purchase_orders SET notes = 'x' WHERE id = $1`, [S.oSame!.id]);
    })).rejects.toThrow(retired);
  });
});
