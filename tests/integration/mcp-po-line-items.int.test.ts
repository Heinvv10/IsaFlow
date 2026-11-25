/**
 * bulk_create_purchase_orders: a line links to its catalogue item by item_id or item_code (docs/design/mcp-po-line-items.md), real
 * PostgreSQL, every call as app_user (poImportHarness):
 *   - the id lands on po_items.item_id; the import LINKS only (account, VAT rate and amounts stay as sent); a free-text line is unchanged;
 *   - refused with the PO and line named, before any write: unknown id / code, ANOTHER company's id / code (same text as unknown),
 *     a deleted item, an inactive item, both given; one bad line refuses the whole batch;
 *   - dry_run runs the same guards (same refusals) and writes nothing; a replay (external_ref) writes nothing and keeps the item.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, counterNext, poCount, sagePo, type Json } from './helpers/poImportHarness';
import { dropMaintExtras, glCount, poLines, seedItem } from './helpers/poMaintHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { parsePurchaseOrderBatch, type ParsedPo } from '@/lib/mcp/tools/purchaseOrderImportArgs';
import { resolveLineItems } from '@/lib/mcp/tools/purchaseOrderImportItems';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
let cab: string;
let theirs: string;
let gone: string;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-line-items');
  other = await seedBillFixture(pool, 'po-line-items-other');
  await setPolicy(pool, f, 'warn');
  cab = await seedItem(pool, f, { code: 'CAB-1', acct: f.acc.travel });
  await seedItem(pool, f, { code: 'OFF-1', acct: f.acc.travel, active: false });
  gone = await seedItem(pool, f, { code: 'GONE-1', acct: f.acc.travel });
  await pool.query('UPDATE items SET deleted_at = now() WHERE id = $1', [gone]);
  theirs = await seedItem(pool, other, { code: 'THEIRS-1', acct: other.acc.travel });
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally {
    await pool.end();
  }
}, 60_000);

let n = 300;
/** A Sage PO whose first line carries `extra` (an item); a second plain line proves the row index. */
const po = (extra: Json | null, opts: { status?: string; ref?: string } = {}): Json => {
  const base = sagePo(++n, f, { status: opts.status ?? 'draft', acct: f.acc.opex, price: 100, ...(opts.ref ? { ref: opts.ref } : {}) });
  const first = (base.lines as Json[])[0]!;
  const { expected_totals: _drop, ...rest } = base;
  return { ...rest, lines: [{ ...first, ...(extra ?? {}) }, { ...first, description: 'Second' }] };
};
const poId = async (num: unknown) => String((await pool.query('SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number = $2', [f.co, num])).rows[0].id);
const snapshot = async () => ({ pos: await poCount(pool, f), counter: await counterNext(pool, f), gl: await glCount(pool, f) });

describe('linking a line to its item', () => {
  it('item_id and item_code land on po_items.item_id; the other lines stay free text; the line is priced exactly as without an item', async () => {
    const byId = po({ item_id: cab }), byCode = po({ item_code: 'CAB-1' }), plain = po(null);
    const r = await callTool(pool, f, create, { purchase_orders: [byId, byCode, plain] });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ created: 3 });
    for (const x of [byId, byCode]) expect((await poLines(pool, await poId(x.po_number))).map((l) => l.item_id)).toEqual([cab, null]);
    expect((await poLines(pool, await poId(plain.po_number))).map((l) => l.item_id)).toEqual([null, null]);
    const [linked, free] = [await poLines(pool, await poId(byId.po_number)), await poLines(pool, await poId(plain.po_number))];
    // The item brings no account, rate or amount: the linked line equals the free-text one (the same inputs, 2 x 100 at 15%).
    expect(linked[0]).toMatchObject({ gl_account_id: f.acc.opex, tax_rate: '15.00', line_total: '200.00', tax_amount: '30.00' });
    expect({ ...linked[0], item_id: null, description: '' }).toEqual({ ...free[0], description: '' });
  });

  it('an uppercase item_id and a padded item_code resolve; a line with an item and no account stays account-less', async () => {
    const p = po({ item_id: cab.toUpperCase(), gl_account_id: undefined });
    const q = po({ item_code: '  CAB-1  ' });
    const r = await callTool(pool, f, create, { purchase_orders: [p, q] });
    expect(r.isError, r.text).toBe(false);
    const lines = await poLines(pool, await poId(p.po_number));
    expect(lines[0]).toMatchObject({ item_id: cab, gl_account_id: null });
    expect((await poLines(pool, await poId(q.po_number)))[0]!.item_id).toBe(cab);
  });

  it('an approved (open) PO with item lines passes the same budget path', async () => {
    const p = po({ item_id: cab }, { status: 'open' });
    const r = await callTool(pool, f, create, { purchase_orders: [p] });
    expect(r.isError, r.text).toBe(false);
    expect((await poLines(pool, await poId(p.po_number)))[0]!.item_id).toBe(cab);
  });
});

describe('refusals name the PO and the line and write nothing', () => {
  const cases: Array<[string, () => Json, RegExp]> = [
    ['unknown item_id', () => ({ item_id: '99999999-9999-4999-8999-999999999999' }), /^purchase_orders\[1\]\.lines\[0\]\.item_id is not an item of your company/],
    ['another company\'s item_id', () => ({ item_id: theirs }), /^purchase_orders\[1\]\.lines\[0\]\.item_id is not an item of your company/],
    ['unknown item_code', () => ({ item_code: 'NOPE' }), /^purchase_orders\[1\]\.lines\[0\]\.item_code: no item with the code "NOPE" in this company/],
    ['another company\'s item_code', () => ({ item_code: 'THEIRS-1' }), /^purchase_orders\[1\]\.lines\[0\]\.item_code: no item with the code "THEIRS-1" in this company/],
    ['a deleted item (by code)', () => ({ item_code: 'GONE-1' }), /^purchase_orders\[1\]\.lines\[0\]\.item_code: no item with the code "GONE-1"/],
    ['a deleted item (by id)', () => ({ item_id: gone }), /^purchase_orders\[1\]\.lines\[0\]\.item_id is not an item of your company/],
    ['an inactive item (by code)', () => ({ item_code: 'OFF-1' }), /^purchase_orders\[1\]\.lines\[0\]\.item_id is an inactive item/],
    ['both given', () => ({ item_id: cab, item_code: 'CAB-1' }), /^purchase_orders\[1\]\.lines\[0\]: give item_id or item_code, not both/],
    ['a malformed item_id', () => ({ item_id: 'cable' }), /^purchase_orders\[1\]\.lines\[0\]\.item_id must be an item UUID/],
  ];

  it.each(cases)('%s refuses the whole batch (PO 1, line 0), live and dry run alike', async (_name, extra, message) => {
    const before = await snapshot();
    const batch = [po(null), po(extra())];
    const live = await callTool(pool, f, create, { purchase_orders: batch });
    expect(live.isError).toBe(true);
    expect(live.text).toMatch(message);
    const dry = await callTool(pool, f, create, { purchase_orders: batch, dry_run: true });
    expect(dry.isError).toBe(true);
    expect(dry.text).toBe(live.text);
    expect(await snapshot()).toEqual(before);
  });

  it('another company\'s id and a nonexistent id get the identical text (no cross-tenant disclosure)', async () => {
    const a = await callTool(pool, f, create, { purchase_orders: [po({ item_id: theirs })] });
    const b = await callTool(pool, f, create, { purchase_orders: [po({ item_id: '99999999-9999-4999-8999-999999999999' })] });
    expect(a.text).toBe(b.text);
    expect(a.text).not.toContain(theirs);
    const c = await callTool(pool, f, create, { purchase_orders: [po({ item_code: 'THEIRS-1' })] });
    const d = await callTool(pool, f, create, { purchase_orders: [po({ item_code: 'NOPE-9' })] });
    expect(c.text.replace('THEIRS-1', 'X')).toBe(d.text.replace('NOPE-9', 'X'));
  });

  it('the second line of a PO is named by its own index', async () => {
    const p = po(null);
    (p.lines as Json[])[1] = { ...(p.lines as Json[])[1], item_code: 'NOPE' };
    const r = await callTool(pool, f, create, { purchase_orders: [p] });
    expect(r.text).toMatch(/^purchase_orders\[0\]\.lines\[1\]\.item_code: no item with the code "NOPE"/);
  });

  it('the first offending line in line order is named, whether it names its item by id or by code', async () => {
    const p = po({ item_id: theirs });
    (p.lines as Json[])[1] = { ...(p.lines as Json[])[1], item_code: 'NOPE' };
    expect((await callTool(pool, f, create, { purchase_orders: [p] })).text).toMatch(/^purchase_orders\[0\]\.lines\[0\]\.item_id is not an item/);
    const q = po({ item_code: 'NOPE' });
    (q.lines as Json[])[1] = { ...(q.lines as Json[])[1], item_id: theirs };
    expect((await callTool(pool, f, create, { purchase_orders: [q] })).text).toMatch(/^purchase_orders\[0\]\.lines\[0\]\.item_code: no item with the code "NOPE"/);
  });

  it('an item refusal never reaches the supplier-of-another-company answer: a good batch after a refused one still works', async () => {
    const bad = await callTool(pool, f, create, { purchase_orders: [po({ item_code: 'NOPE' })] });
    expect(bad.isError).toBe(true);
    const good = await callTool(pool, f, create, { purchase_orders: [po({ item_code: 'CAB-1' })] });
    expect(good.isError, good.text).toBe(false);
  });
});

describe('dry_run parity and replay', () => {
  it('a dry run of a valid linked batch writes nothing, then the live call creates it with the links', async () => {
    const p = po({ item_code: 'CAB-1' }, { status: 'open' });
    const before = await snapshot();
    const dry = await callTool(pool, f, create, { purchase_orders: [p], dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, would_create: 1 });
    expect(dry.wroteNothing).toBe(true);
    expect(await snapshot()).toEqual(before);
    const live = await callTool(pool, f, create, { purchase_orders: [p] });
    expect(live.isError, live.text).toBe(false);
    expect((await poLines(pool, await poId(p.po_number)))[0]!.item_id).toBe(cab);
  });

  it('a replay by external_ref is already_existed, writes nothing and keeps the stored link', async () => {
    const p = po({ item_id: cab }, { ref: 'replay-1' });
    expect((await callTool(pool, f, create, { purchase_orders: [p] })).isError).toBe(false);
    const before = await snapshot();
    const again = await callTool(pool, f, create, { purchase_orders: [p] });
    expect(again.isError, again.text).toBe(false);
    expect(again.body).toMatchObject({ created: 0, already_existed: 1 });
    expect((again.body.purchase_orders as Json[])[0]).not.toHaveProperty('differences');
    expect(again.wroteNothing).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await poLines(pool, await poId(p.po_number))).map((l) => l.item_id)).toEqual([cab, null]);
  });

  it('a replay that adds or changes a line\'s item is reported in differences, never silently dropped, and writes nothing', async () => {
    const other2 = await seedItem(pool, f, { code: 'CAB-2', acct: f.acc.travel });
    const p = po(null, { ref: 'replay-2' });
    expect((await callTool(pool, f, create, { purchase_orders: [p] })).isError).toBe(false);
    const withItem = (id: string, code?: string) => ({ ...p, lines: (p.lines as Json[]).map((l, i) => (i === 0 ? { ...l, ...(code ? { item_code: code } : { item_id: id }) } : l)) });
    const before = await snapshot();
    const added = await callTool(pool, f, create, { purchase_orders: [withItem(cab)] });
    expect(added.isError, added.text).toBe(false);
    expect((added.body.purchase_orders as Json[])[0]).toMatchObject({
      already_existed: true, payload_differs: true, differences: [{ field: 'lines[0].item_id', existing: null, requested: cab }],
    });
    expect(added.wroteNothing).toBe(true);
    expect((await poLines(pool, await poId(p.po_number))).map((l) => l.item_id)).toEqual([null, null]);
    // The stored link is cab: the same item is no difference, a different one (by code too) is.
    await pool.query('UPDATE po_items SET item_id = $1 WHERE purchase_order_id = $2 AND sort_order = 0', [cab, await poId(p.po_number)]);
    const same = await callTool(pool, f, create, { purchase_orders: [withItem(cab)] });
    expect((same.body.purchase_orders as Json[])[0]).toMatchObject({ already_existed: true, payload_differs: false });
    const changed = await callTool(pool, f, create, { purchase_orders: [withItem('', 'CAB-2')] });
    expect((changed.body.purchase_orders as Json[])[0]).toMatchObject({
      payload_differs: true, differences: [{ field: 'lines[0].item_id', existing: cab, requested: other2 }],
    });
    expect(await snapshot()).toEqual(before);
    expect((await poLines(pool, await poId(p.po_number))).map((l) => l.item_id)).toEqual([cab, null]);
  });

  it('a replay naming an item deactivated since the first import is refused, not replayed', async () => {
    const soon = await seedItem(pool, f, { code: 'SOON-OFF', acct: f.acc.travel });
    const p = po({ item_id: soon }, { ref: 'replay-3' });
    expect((await callTool(pool, f, create, { purchase_orders: [p] })).isError).toBe(false);
    await pool.query('UPDATE items SET is_active = false WHERE id = $1', [soon]);
    const before = await snapshot();
    const again = await callTool(pool, f, create, { purchase_orders: [p] });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/^purchase_orders\[0\]\.lines\[0\]\.item_id is an inactive item/);
    expect(await snapshot()).toEqual(before);
  });
});

describe('the lookup is scoped by company_id itself, not only by RLS', () => {
  // Outside a request transaction `sql` runs as the fixture's superuser, which RLS does not bind: only the query's own
  // company_id predicate then keeps another company's item out (defence in depth under the app_user policies the tests above run in).
  const parsedBatch = (extra: Json) => parsePurchaseOrderBatch([po(extra)]) as ParsedPo[];

  it('another company\'s id and code are not resolved for this company, and resolve for their own', async () => {
    expect(await resolveLineItems(f.co, parsedBatch({ item_id: theirs }))).toBe('purchase_orders[0].lines[0].item_id is not an item of your company');
    expect(await resolveLineItems(f.co, parsedBatch({ item_code: 'THEIRS-1' }))).toBe('purchase_orders[0].lines[0].item_code: no item with the code "THEIRS-1" in this company');
    expect(await resolveLineItems(other.co, parsedBatch({ item_id: theirs }))).toEqual(new Map([['0:0', theirs]]));
    expect(await resolveLineItems(other.co, parsedBatch({ item_code: 'THEIRS-1' }))).toEqual(new Map([['0:0', theirs]]));
  });

  it('an inactive item is refused whichever way it is named', async () => {
    const off = String((await pool.query("SELECT id FROM items WHERE company_id = $1 AND code = 'OFF-1'", [f.co])).rows[0].id);
    expect(await resolveLineItems(f.co, parsedBatch({ item_id: off }))).toBe('purchase_orders[0].lines[0].item_id is an inactive item');
    expect(await resolveLineItems(f.co, parsedBatch({ item_code: 'OFF-1' }))).toBe('purchase_orders[0].lines[0].item_id is an inactive item');
  });
});
