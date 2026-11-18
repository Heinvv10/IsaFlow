/**
 * Item master (Phase A) against a real database, through the real registry as app_user: 383 synthetic Sage-shaped items
 * (271 physical, 112 service, six categories) upserted in one call; the same payload re-run reports all 383 unchanged and
 * writes nothing; every item comes back by code and by external reference and through the cursor; another company's
 * items, categories and accounts are out of reach; stock_movements rows are company-scoped by their own column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, cleanupWorld, CATEGORIES, itemsWorld, sageItems, type ItemsWorld } from './helpers/itemsWorld';
import { text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

let w: ItemsWorld;
let A: ReturnType<typeof as>;
let B: ReturnType<typeof as>;
let payload: Array<Record<string, unknown>>;
type Row = { index: number; outcome: string; id: string | null; code: string };
const rowsOf = (r: Record<string, unknown>) => r.rows as Row[];

beforeAll(async () => {
  w = await itemsWorld(pool);
  A = as(pool, w.a);
  B = as(pool, w.b);
  payload = sageItems(w.a);
  for (const code of CATEGORIES) await A.ok('upsert_item_category', { name: `${code[0]!.toUpperCase()}${code.slice(1)}`, code, external_system: 'sage', external_ref: `cat-${code}` });
}, 120000);
afterAll(async () => {
  try { await cleanupWorld(pool, w); } finally { await pool.end(); }
}, 120000);

const stamp = async (companyId: string) => (await pool.query(
  'SELECT id, xmin::text AS x, updated_at FROM items WHERE company_id = $1 ORDER BY code', [companyId])).rows;

describe('383 Sage-shaped items', () => {
  it('a dry run previews 383 creates and writes nothing', async () => {
    const dry = await A.ok('bulk_upsert_items', { items: payload, dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, written: false, counts: { created: 383, updated: 0, unchanged: 0, total: 383 } });
    expect((await stamp(w.a.u.homeCompanyId))).toHaveLength(0);
  });

  it('creates all 383 in one call, 271 physical and 112 service, none tracked', async () => {
    const live = await A.ok('bulk_upsert_items', { items: payload });
    expect(live).toMatchObject({ written: true, counts: { created: 383, updated: 0, unchanged: 0, total: 383 } });
    expect(rowsOf(live).every((r) => typeof r.id === 'string')).toBe(true);
    const c = w.a.u.homeCompanyId;
    const by = (await pool.query(`SELECT item_type, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE inventory_tracked)::int AS tracked FROM items WHERE company_id = $1 GROUP BY 1`, [c])).rows;
    expect(Object.fromEntries(by.map((r) => [r.item_type, r.n]))).toEqual({ physical: 271, service: 112 });
    expect(by.every((r) => r.tracked === 0)).toBe(true);
    const cats = (await pool.query(`SELECT ic.code, COUNT(*)::int AS n FROM items i JOIN item_categories ic ON ic.id = i.category_id WHERE i.company_id = $1 GROUP BY 1`, [c])).rows;
    expect(cats.map((r) => r.code).sort()).toEqual([...CATEGORIES].sort());
  });

  it('re-running the SAME payload reports all 383 unchanged and writes nothing (no row is touched)', async () => {
    const before = await stamp(w.a.u.homeCompanyId);
    expect(before).toHaveLength(383);
    const again = await A.ok('bulk_upsert_items', { items: payload });
    expect(again).toMatchObject({ written: false, counts: { created: 0, updated: 0, unchanged: 383, total: 383 } });
    expect(rowsOf(again).every((r) => r.outcome === 'unchanged')).toBe(true);
    expect(await stamp(w.a.u.homeCompanyId)).toEqual(before);
  });

  it('a changed price is the one update, and its re-run is unchanged again', async () => {
    const edited = payload.map((r, i) => (i === 100 ? { ...r, sales_price: 999.99 } : r));
    const one = await A.ok('bulk_upsert_items', { items: edited });
    expect(one).toMatchObject({ counts: { created: 0, updated: 1, unchanged: 382, total: 383 } });
    expect(rowsOf(one)[100]).toMatchObject({ outcome: 'updated', changed: ['sales_price'] });
    expect(await A.ok('bulk_upsert_items', { items: edited })).toMatchObject({ counts: { unchanged: 383 } });
    await A.ok('bulk_upsert_items', { items: payload }); // back to the original for the reads below
  });

  it('every item comes back by code and by external reference', async () => {
    const steps = payload.flatMap((r) => [
      () => ['get_item', { code: r.code }] as [string, Record<string, unknown>],
      () => ['get_item', { external_system: 'sage', external_ref: r.external_ref }] as [string, Record<string, unknown>],
    ]);
    const out = await A.batch(steps);
    expect(out).toHaveLength(766);
    for (let i = 0; i < payload.length; i++) {
      const byCode = JSON.parse(text(out[2 * i]!)).item;
      const byRef = JSON.parse(text(out[2 * i + 1]!)).item;
      expect(byRef.id).toBe(byCode.id);
      expect(byCode).toMatchObject({ code: payload[i]!.code, item_type: payload[i]!.item_type, external_ref: payload[i]!.external_ref, purchase_price: payload[i]!.purchase_price, sales_price: payload[i]!.sales_price });
    }
  }, 120000);

  it('list_items pages through all 383 by cursor with no repeat or gap, and the filters narrow', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await A.ok('list_items', cursor ? { cursor } : {});
      expect(r.rowsTotal).toBe(383);
      seen.push(...(r.rows as Array<{ code: string }>).map((x) => x.code));
      cursor = (r.next_cursor as string | null) ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(payload.map((r) => r.code));
    expect((await A.ok('list_items', { type: 'service', detail: 'summary' })).rowsTotal).toBe(112);
    expect((await A.ok('list_items', { external_system: 'sage', external_ref: '50007' })).rows).toHaveLength(1);
    expect((await A.ok('find_by_external_ref', { source: 'sage', kind: 'item', id: 50007 })).record).toMatchObject({ entity_type: 'item', number: 'SGE-0007' });
  });

  it('deactivate_item retires one, is idempotent, and update_item can bring it back', async () => {
    const id = ((await A.ok('get_item', { code: 'SGE-0003' })).item as { id: string }).id;
    expect(await A.ok('deactivate_item', { item_id: id })).toMatchObject({ is_active: false, changed: true });
    expect(await A.ok('deactivate_item', { item_id: id })).toMatchObject({ is_active: false, changed: false });
    expect((await A.ok('list_items', { is_active: false })).rowsTotal).toBe(1);
    expect(await A.ok('update_item', { item_id: id, is_active: true })).toMatchObject({ outcome: 'updated', changed: ['is_active'] });
  });
});

describe('one bad row refuses the whole batch', () => {
  it('writes nothing and lists every refusal with its index and code', async () => {
    const before = await stamp(w.a.u.homeCompanyId);
    const rows = [
      { code: 'NEW-1', description: 'fine' },
      { code: 'NEW-2', description: 'bad category', category_code: 'nope' },
      { ...payload[0]!, external_ref: '99999' }, // SGE-0001 already carries a different reference
      { code: 'NEW-3', description: 'tracked service', item_type: 'service', inventory_tracked: true },
      { code: 'NEW-1', description: 'repeat' },
    ];
    const r = await A.run('bulk_upsert_items', { items: rows });
    expect(r.isError).toBe(true);
    const refusals = JSON.parse(text(r)).refusals as Array<{ index: number; code: string }>;
    expect(refusals.map((x) => `${x.index}:${x.code}`)).toEqual([
      '1:category_not_found', '2:code_in_use_by_other_ref', '3:service_cannot_be_tracked', '4:duplicate_in_request',
    ]);
    expect(await stamp(w.a.u.homeCompanyId)).toEqual(before);
    expect((await pool.query(`SELECT 1 FROM items WHERE company_id = $1 AND code = 'NEW-1'`, [w.a.u.homeCompanyId])).rowCount).toBe(0);
  });
});

describe('another company is out of reach', () => {
  it('B cannot read, change or retire A\'s items, and A\'s category and accounts mean nothing to B', async () => {
    const id = ((await A.ok('get_item', { code: 'SGE-0010' })).item as { id: string }).id;
    expect(text(await B.run('get_item', { item_id: id }))).toBe('Not found');
    expect(text(await B.run('get_item', { code: 'SGE-0010' }))).toBe('Not found');
    expect(text(await B.run('update_item', { item_id: id, description: 'hijack' }))).toBe('Not found');
    expect(text(await B.run('deactivate_item', { item_id: id }))).toBe('Not found');
    expect((await B.ok('list_items')).rowsTotal).toBe(0);
    expect((await B.ok('list_item_categories')).total).toBe(0);
    expect((await pool.query('SELECT description FROM items WHERE id = $1', [id])).rows[0].description).toBe(payload[9]!.description);

    const aCategory = ((await A.ok('list_item_categories')).categories as Array<{ id: string }>)[0]!.id;
    const r = await B.run('bulk_upsert_items', { items: [
      { code: 'B-1', description: 'x', category_id: aCategory },
      { code: 'B-2', description: 'x', sales_account_id: w.a.revenue },
      { code: 'B-3', description: 'x', purchases_account_id: w.b.inactive },
    ] });
    expect((JSON.parse(text(r)).refusals as Array<{ index: number; code: string }>).map((x) => `${x.index}:${x.code}`))
      .toEqual(['0:category_not_found', '1:account_not_found', '2:account_inactive']);
  });

  it('the same code and the same external reference live independently in each company', async () => {
    const mine = await B.ok('bulk_upsert_items', { items: [{ code: 'SGE-0010', description: 'B own', external_system: 'sage', external_ref: '50010' }] });
    expect(mine).toMatchObject({ counts: { created: 1 } });
    expect((await B.ok('get_item', { external_system: 'sage', external_ref: '50010' })).item).toMatchObject({ description: 'B own' });
    expect((await A.ok('get_item', { external_system: 'sage', external_ref: '50010' })).item).toMatchObject({ description: payload[9]!.description });
  });

  it('row level security: as app_user acting for B, A\'s items are invisible and unwritable', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: w.b.u.userId, role: 'authenticated', company_id: w.b.u.homeCompanyId })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [w.b.u.homeCompanyId]);
      expect((await client.query('SELECT COUNT(*)::int AS n FROM items WHERE company_id = $1', [w.a.u.homeCompanyId])).rows[0].n).toBe(0);
      expect((await client.query('UPDATE items SET description = $2 WHERE company_id = $1', [w.a.u.homeCompanyId, 'x'])).rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('stock_movements are company-scoped (migration 1002)', () => {
  let productA: string;
  let productB: string;
  let itemA: string;

  beforeAll(async () => {
    const prod = async (company: string, code: string) => String((await pool.query(
      'INSERT INTO products (company_id, code, name) VALUES ($1, $2, $3) RETURNING id', [company, code, code])).rows[0].id);
    productA = await prod(w.a.u.homeCompanyId, 'IA-P1');
    productB = await prod(w.b.u.homeCompanyId, 'IB-P1');
    itemA = ((await A.ok('get_item', { code: 'SGE-0020' })).item as { id: string }).id;
    await pool.query(`INSERT INTO stock_movements (company_id, product_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'purchase', 5)`, [w.a.u.homeCompanyId, productA, itemA]);
    await pool.query(`INSERT INTO stock_movements (company_id, product_id, movement_type, quantity) VALUES ($1, $2, 'purchase', 7)`, [w.b.u.homeCompanyId, productB]);
  });

  const asAppUser = async <T>(company: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: company === w.a.u.homeCompanyId ? w.a.u.userId : w.b.u.userId, role: 'authenticated', company_id: company })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [company]);
      return await fn((s, p) => client.query(s, p));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  it('each company reads only its own movements', async () => {
    const seen = async (company: string) => asAppUser(company, async (q) => (await q('SELECT company_id, quantity FROM stock_movements')).rows);
    expect(await seen(w.a.u.homeCompanyId)).toEqual([{ company_id: w.a.u.homeCompanyId, quantity: '5.00' }]);
    expect(await seen(w.b.u.homeCompanyId)).toEqual([{ company_id: w.b.u.homeCompanyId, quantity: '7.00' }]);
  });

  it('a movement for another company, or with no company, is refused', async () => {
    await expect(asAppUser(w.a.u.homeCompanyId, (q) => q(
      `INSERT INTO stock_movements (company_id, product_id, movement_type, quantity) VALUES ($1, $2, 'purchase', 1)`, [w.b.u.homeCompanyId, productB],
    ))).rejects.toThrow(/row-level security/);
    await expect(pool.query(`INSERT INTO stock_movements (product_id, movement_type, quantity) VALUES ($1, 'purchase', 1)`, [productA]))
      .rejects.toThrow(/stock_movements_company_id_not_null/);
    const warehouse = String((await pool.query(`INSERT INTO warehouses (company_id, name, code) VALUES ($1, 'IA store', 'IA-W1') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    await expect(pool.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) VALUES ($1, $2, 1)', [productA, warehouse]))
      .rejects.toThrow(/stock_levels_company_id_not_null/);
    await pool.query('INSERT INTO stock_levels (company_id, product_id, warehouse_id, quantity) VALUES ($1, $2, $3, 1)', [w.a.u.homeCompanyId, productA, warehouse]);
    expect(await asAppUser(w.b.u.homeCompanyId, async (q) => (await q('SELECT COUNT(*)::int AS n FROM stock_levels')).rows[0].n)).toBe(0);
    expect(await asAppUser(w.a.u.homeCompanyId, async (q) => (await q('SELECT COUNT(*)::int AS n FROM stock_levels')).rows[0].n)).toBe(1);
    await pool.query('DELETE FROM stock_levels WHERE company_id = $1', [w.a.u.homeCompanyId]);
    await pool.query('DELETE FROM warehouses WHERE id = $1', [warehouse]);
  });

  it('an item with movements cannot become a service (has_stock_movements), through update_item and bulk_upsert_items', async () => {
    const one = await A.run('update_item', { item_id: itemA, item_type: 'service' });
    expect(text(one)).toMatch(/^has_stock_movements:/);
    const bulk = await A.run('bulk_upsert_items', { items: [{ code: 'SGE-0020', item_type: 'service' }] });
    expect(JSON.parse(text(bulk)).refusals[0]).toMatchObject({ index: 0, code: 'has_stock_movements' });
    expect((await pool.query('SELECT item_type FROM items WHERE id = $1', [itemA])).rows[0].item_type).toBe('physical');
  });
});
