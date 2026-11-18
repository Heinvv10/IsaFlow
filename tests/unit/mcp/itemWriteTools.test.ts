/**
 * bulk_upsert_items, update_item, deactivate_item, upsert_item_category (Phase A), driven through the REAL registry and the
 * real planner over a fake `sql`. Every write tool has: a company guard, an idempotency key, a dry run with the live
 * path's guards that writes nothing and does not consume the key, per-row refusal reasons, and nothing written on refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/items/itemUpsertContext', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/items/itemUpsertContext')>()),
  loadUpsertContext: vi.fn(),
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { loadUpsertContext } from '@/modules/accounting/services/items/itemUpsertContext';
import { ITEM_WRITE_TOOLS } from '@/lib/mcp/tools/itemToolSet';
import { ACC, CAT, COMPANY, OTHER, ctxOf, installFakeSql, sqlMock, stored, upsertCtx, type FakeDb } from './itemToolsHarness';

let db: FakeDb;
let registry: McpRegistry;
const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, ctxOf());
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const itemWrites = () => db.writes.filter((w) => w.includes('INSERT INTO items') || w.includes('UPDATE items'));

beforeEach(() => {
  db = installFakeSql();
  registry = new McpRegistry();
  for (const t of ITEM_WRITE_TOOLS) registry.register(t);
  vi.mocked(loadUpsertContext).mockReset();
  vi.mocked(loadUpsertContext).mockResolvedValue(upsertCtx());
});

const ROWS = [
  { code: 'FIB-1', description: 'Fibre 1km', sales_price: 15, category_code: 'optics', external_system: 'sage', external_ref: '1' },
  { code: 'SVC-1', description: 'Install', item_type: 'service', sales_price: 100, external_system: 'sage', external_ref: '2' },
];

describe('every item write tool', () => {
  it('sits on write:items, writes (so the role fence and idempotency key apply) and posts nothing', () => {
    for (const t of ITEM_WRITE_TOOLS) {
      expect(t.scope).toBe('write:items');
      expect(t.write).toBe(true);
      expect(t.requiresPost).toBeUndefined();
      expect('dry_run' in (t.inputSchema.properties as object)).toBe(true);
    }
  });

  it('refuses a company_id that is not the token\'s BEFORE the handler: nothing is read or written', async () => {
    for (const [name, args] of [
      ['bulk_upsert_items', { items: ROWS }], ['update_item', { item_id: ACC, description: 'x' }],
      ['deactivate_item', { item_id: ACC }], ['upsert_item_category', { name: 'Optics' }],
    ] as const) {
      const r = await call(name, { ...args, company_id: OTHER, idempotency_key: `k-${name}` });
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text, name).toMatch(/does not match this token's company/);
    }
    expect(loadUpsertContext).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('needs an idempotency_key and a write role', async () => {
    expect((await registry.call('bulk_upsert_items', { items: ROWS }, ctxOf())).content[0]!.text).toMatch(/idempotency_key is required/);
    const viewer = { ...ctxOf(), companyRole: 'viewer' };
    expect((await registry.call('bulk_upsert_items', { items: ROWS, idempotency_key: 'k' }, viewer)).isError).toBe(true);
    expect(loadUpsertContext).not.toHaveBeenCalled();
  });
});

describe('bulk_upsert_items', () => {
  it('creates the rows in one call and reports each outcome with its id', async () => {
    const r = await call('bulk_upsert_items', { items: ROWS, idempotency_key: 'k1' });
    expect(r.isError).toBeUndefined();
    const b = body(r);
    expect(b.counts).toEqual({ created: 2, updated: 0, unchanged: 0, total: 2 });
    expect(b.written).toBe(true);
    expect(b.rows.map((x: { outcome: string }) => x.outcome)).toEqual(['created', 'created']);
    expect(b.rows[0].id).toMatch(/^aaaaaaaa-/);
    expect(itemWrites()).toHaveLength(2);
  });

  it('is ALL OR NOTHING: one refused row writes nothing and every refusal comes back with its index and code', async () => {
    const rows = [
      ROWS[0], { code: 'BAD', description: 'x', category_code: 'nope' }, ROWS[1],
      { code: 'BAD2', description: 'x', purchase_price: -1 }, { code: 'FIB-1', description: 'dup' },
    ];
    const r = await call('bulk_upsert_items', { items: rows, idempotency_key: 'k1' });
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b).toMatchObject({ refused: true, written: false, dry_run: false });
    expect(b.refusals.map((x: { index: number; code: string }) => `${x.index}:${x.code}`)).toEqual([
      '1:category_not_found', '3:invalid_field', '4:duplicate_in_request',
    ]);
    expect(b.refusals.every((x: { reason: string }) => x.reason.length > 0)).toBe(true);
    expect(itemWrites()).toEqual([]);
  });

  it('a refusal does not consume the idempotency key: the corrected call with the same key writes', async () => {
    await call('bulk_upsert_items', { items: [{ code: 'X' }], idempotency_key: 'k1' }); // no description: refused
    expect(db.audit.at(-1)).toMatchObject({ status: 'rejected', key: null });
    const r = await call('bulk_upsert_items', { items: [{ code: 'X', description: 'fixed' }], idempotency_key: 'k1' });
    expect(r.isError).toBeUndefined();
    expect(itemWrites()).toHaveLength(1);
  });

  it('a re-run of identical input reports every row unchanged and writes nothing', async () => {
    const existing = ROWS.map((r, i) => stored({
      id: `bbbbbbbb-0000-4000-8000-00000000000${i}`, code: r.code, description: r.description, itemType: r.item_type ?? 'physical',
      salesPrice: r.sales_price, externalSystem: 'sage', externalRef: r.external_ref, categoryId: i === 0 ? CAT : null,
    }));
    vi.mocked(loadUpsertContext).mockResolvedValue(upsertCtx(existing));
    const r = await call('bulk_upsert_items', { items: ROWS, idempotency_key: 'k2' });
    const b = body(r);
    expect(b.counts).toEqual({ created: 0, updated: 0, unchanged: 2, total: 2 });
    expect(b.written).toBe(false);
    expect(b.rows.map((x: { outcome: string }) => x.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(itemWrites()).toEqual([]);
  });

  it('updates only what differs and names the changed fields', async () => {
    vi.mocked(loadUpsertContext).mockResolvedValue(upsertCtx([stored({ id: 'bbbbbbbb-0000-4000-8000-000000000001', code: 'FIB-1', description: 'Old', salesPrice: 15 })]));
    const r = await call('bulk_upsert_items', { items: [{ code: 'FIB-1', description: 'Fibre 1km', sales_price: 15 }], idempotency_key: 'k3' });
    expect(body(r).rows[0]).toMatchObject({ outcome: 'updated', changed: ['description'] });
    expect(itemWrites()).toHaveLength(1);
  });

  it('refuses a row whose reference and code hit two different items', async () => {
    vi.mocked(loadUpsertContext).mockResolvedValue(upsertCtx([
      stored({ id: 'bbbbbbbb-0000-4000-8000-000000000001', code: 'A', externalSystem: 'sage', externalRef: '1' }),
      stored({ id: 'bbbbbbbb-0000-4000-8000-000000000002', code: 'B', externalSystem: 'sage', externalRef: '2' }),
    ]));
    const r = await call('bulk_upsert_items', { items: [{ code: 'B', external_system: 'sage', external_ref: '1' }], idempotency_key: 'k4' });
    expect(body(r).refusals).toEqual([expect.objectContaining({ index: 0, code: 'ref_code_conflict' })]);
    expect(itemWrites()).toEqual([]);
  });

  it('refuses more than 500 rows and a non-array before reading anything', async () => {
    const big = Array.from({ length: 501 }, (_, i) => ({ code: `C${i}`, description: 'd' }));
    expect((await call('bulk_upsert_items', { items: big, idempotency_key: 'k5' })).content[0]!.text).toMatch(/at most|maximum is 500/);
    expect((await call('bulk_upsert_items', { items: 'x', idempotency_key: 'k6' })).isError).toBe(true);
    expect(loadUpsertContext).not.toHaveBeenCalled();
  });

  describe('dry run', () => {
    it('returns the live call\'s outcomes, writes nothing and does not consume the key: preview, then apply on one key', async () => {
      const preview = await call('bulk_upsert_items', { items: ROWS, dry_run: true, idempotency_key: 'k7' });
      expect(body(preview)).toMatchObject({ dry_run: true, written: false, counts: { created: 2, updated: 0, unchanged: 0, total: 2 } });
      expect(itemWrites()).toEqual([]);
      // the registry stored the dry run under NO key
      expect(db.audit.at(-1)).toMatchObject({ tool: 'bulk_upsert_items', status: 'ok', key: null });

      const live = await call('bulk_upsert_items', { items: ROWS, idempotency_key: 'k7' });
      expect(live.isError).toBeUndefined();
      expect(live.content[0]!.text).not.toMatch(/already used/);
      expect(body(live).written).toBe(true);
      expect(itemWrites()).toHaveLength(2);
      expect(db.audit.at(-1)).toMatchObject({ key: 'k7', status: 'ok' });
    });

    it('refuses exactly what the live call refuses (parity), with the same refusals and nothing written', async () => {
      const rows = [ROWS[0], { code: 'BAD', description: 'x', purchases_account_id: OTHER }];
      const dry = await call('bulk_upsert_items', { items: rows, dry_run: true, idempotency_key: 'k8' });
      const live = await call('bulk_upsert_items', { items: rows, idempotency_key: 'k8' });
      expect(dry.isError).toBe(true);
      expect(live.isError).toBe(true);
      expect(body(dry).refusals).toEqual(body(live).refusals);
      expect(body(dry).refusals[0]).toMatchObject({ index: 1, code: 'account_not_found' });
      expect(itemWrites()).toEqual([]);
    });

    it('refuses a dry_run that is not a boolean (it would otherwise run live)', async () => {
      const r = await registry.call('bulk_upsert_items', { items: ROWS, dry_run: 'true', idempotency_key: 'k9' }, ctxOf());
      expect(r.content[0]!.text).toMatch(/dry_run must be true or false/);
      expect(itemWrites()).toEqual([]);
    });
  });
});

describe('update_item', () => {
  const ID = 'bbbbbbbb-0000-4000-8000-000000000001';
  const withItem = (over = {}, movements: string[] = []) =>
    vi.mocked(loadUpsertContext).mockResolvedValue(upsertCtx([stored({ id: ID, code: 'A', description: 'Old', ...over })], movements));

  it('changes the named field only and reports it', async () => {
    withItem();
    const r = await call('update_item', { item_id: ID, description: 'New', idempotency_key: 'u1' });
    expect(body(r)).toMatchObject({ id: ID, outcome: 'updated', changed: ['description'], dry_run: false });
    expect(itemWrites()).toHaveLength(1);
  });

  it('answers an item that is not this company\'s with the generic miss and writes nothing', async () => {
    const r = await call('update_item', { item_id: ACC, description: 'New', idempotency_key: 'u2' });
    expect(r.content[0]!.text).toBe('Not found');
    expect(itemWrites()).toEqual([]);
  });

  it('refuses turning an item with stock movements into a service', async () => {
    withItem({}, [ID]);
    const r = await call('update_item', { item_id: ID, item_type: 'service', idempotency_key: 'u3' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^has_stock_movements:/);
    expect(itemWrites()).toEqual([]);
  });

  it('dry run: same refusal as live, and a clean preview writes nothing and keeps the key', async () => {
    withItem({}, [ID]);
    const dry = await call('update_item', { item_id: ID, item_type: 'service', dry_run: true, idempotency_key: 'u4' });
    expect(dry.content[0]!.text).toMatch(/^has_stock_movements:/);
    withItem();
    const preview = await call('update_item', { item_id: ID, description: 'New', dry_run: true, idempotency_key: 'u5' });
    expect(body(preview)).toMatchObject({ dry_run: true, outcome: 'updated' });
    expect(itemWrites()).toEqual([]);
    expect(db.audit.at(-1)).toMatchObject({ key: null });
    expect((await call('update_item', { item_id: ID, description: 'New', idempotency_key: 'u5' })).isError).toBeUndefined();
    expect(itemWrites()).toHaveLength(1);
  });

  it('a change to nothing succeeds as unchanged; no fields, a bad id and an unknown field are refused', async () => {
    withItem();
    expect(body(await call('update_item', { item_id: ID, description: 'Old', idempotency_key: 'u6' }))).toMatchObject({ outcome: 'unchanged' });
    expect((await call('update_item', { item_id: ID, idempotency_key: 'u7' })).content[0]!.text).toMatch(/at least one field/);
    expect((await call('update_item', { item_id: 'nope', description: 'x', idempotency_key: 'u8' })).content[0]!.text).toBe('invalid item_id');
    expect((await call('update_item', { item_id: ID, price: 5, idempotency_key: 'u9' })).content[0]!.text).toMatch(/^unknown_field:/);
    expect(itemWrites()).toEqual([]);
  });
});

describe('deactivate_item', () => {
  const ID = 'bbbbbbbb-0000-4000-8000-000000000001';

  it('retires an active item, and is idempotent on an inactive one (changed: false, nothing written)', async () => {
    db.reads.deactivate = [{ id: ID, code: 'A', is_active: true }];
    const first = await call('deactivate_item', { item_id: ID, idempotency_key: 'd1' });
    expect(body(first)).toMatchObject({ id: ID, is_active: false, changed: true });
    expect(itemWrites()).toHaveLength(1);

    db.writes.length = 0;
    db.reads.deactivate = [{ id: ID, code: 'A', is_active: false }];
    const again = await call('deactivate_item', { item_id: ID, idempotency_key: 'd2' });
    expect(body(again)).toMatchObject({ is_active: false, changed: false });
    expect(itemWrites()).toEqual([]);
  });

  it('answers a foreign or unknown item with the generic miss', async () => {
    db.reads.deactivate = [];
    expect((await call('deactivate_item', { item_id: ID, idempotency_key: 'd3' })).content[0]!.text).toBe('Not found');
    expect(itemWrites()).toEqual([]);
  });

  it('dry run reports the change and writes nothing; the live call with the same key then writes', async () => {
    db.reads.deactivate = [{ id: ID, code: 'A', is_active: true }];
    const dry = await call('deactivate_item', { item_id: ID, dry_run: true, idempotency_key: 'd4' });
    expect(body(dry)).toMatchObject({ dry_run: true, changed: true, is_active: true });
    expect(itemWrites()).toEqual([]);
    expect(db.audit.at(-1)).toMatchObject({ key: null });
    expect((await call('deactivate_item', { item_id: ID, idempotency_key: 'd4' })).isError).toBeUndefined();
    expect(itemWrites()).toHaveLength(1);
  });
});

describe('upsert_item_category', () => {
  const rowOf = (over: Record<string, unknown> = {}) => ({ id: CAT, name: 'Optics', code: 'optics', description: null, is_active: true, external_system: null, external_ref: null, ...over });

  it('creates, then reports unchanged for the same input', async () => {
    const created = await call('upsert_item_category', { name: 'Optics', code: 'optics', idempotency_key: 'c1' });
    expect(body(created)).toMatchObject({ outcome: 'created' });
    expect(db.writes.filter((w) => w.includes('INSERT INTO item_categories'))).toHaveLength(1);

    db.writes.length = 0;
    db.reads.categories = [rowOf()];
    const again = await call('upsert_item_category', { name: 'Optics', code: 'optics', idempotency_key: 'c2' });
    expect(body(again)).toMatchObject({ outcome: 'unchanged', id: CAT });
    expect(db.writes).toEqual([]);
  });

  it('updates a category matched by code and refuses a name another category holds', async () => {
    db.reads.categories = [rowOf()];
    const renamed = await call('upsert_item_category', { name: 'Optical', code: 'optics', idempotency_key: 'c3' });
    expect(body(renamed)).toMatchObject({ outcome: 'updated', changed: ['name'] });

    db.writes.length = 0;
    db.reads.categories = [rowOf(), rowOf({ id: 'cccccccc-0000-4000-8000-000000000009', name: 'Poles', code: 'poles' })];
    const clash = await call('upsert_item_category', { name: 'Poles', code: 'optics', idempotency_key: 'c4' });
    expect(clash.content[0]!.text).toMatch(/^name_in_use:/);
    expect(db.writes).toEqual([]);
  });

  it('dry run writes nothing and keeps the key; invalid input is refused', async () => {
    const dry = await call('upsert_item_category', { name: 'Optics', dry_run: true, idempotency_key: 'c5' });
    expect(body(dry)).toMatchObject({ dry_run: true, outcome: 'created' });
    expect(db.writes).toEqual([]);
    expect(db.audit.at(-1)).toMatchObject({ key: null });
    expect((await call('upsert_item_category', { name: '  ', idempotency_key: 'c6' })).content[0]!.text).toMatch(/^invalid_field:/);
    expect((await call('upsert_item_category', { name: 'X', external_ref: '1', idempotency_key: 'c7' })).content[0]!.text).toMatch(/external_system is required/);
  });
});

it('the fake company is the token\'s: no item statement names another company', async () => {
  await call('bulk_upsert_items', { items: ROWS, idempotency_key: 'z1' });
  const values = (sqlMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.flatMap((c) => c.slice(1));
  expect(values).toContain(COMPANY);
  expect(values).not.toContain(OTHER);
});
