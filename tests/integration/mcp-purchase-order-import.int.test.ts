/**
 * bulk_create_purchase_orders + list_purchase_orders + find_by_external_ref (brief 2026-11-18, Sage PO migration), real
 * PostgreSQL, every call as app_user (poImportHarness):
 *   - a 100-PO batch with explicit numbers round-trips: the same numbers come back, each PO's totals equal what was
 *     sent, the counter ends one past the highest number and the next number the app mints follows it;
 *   - a re-run under a new key creates nothing (already_existed 100, the key left free); a number already in the books
 *     refuses the whole batch with nothing written; a number or reference named twice in a batch is refused;
 *   - dry_run reports and writes nothing (no PO, no counter move, no audit row); a foreign supplier is "Not found".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import {
  asOwner, callTool, counterNext, dropPoDocuments, poCount, poNumber, sagePo, type Json,
} from './helpers/poImportHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { listPurchaseOrdersTool as list } from '@/lib/mcp/tools/listPurchaseOrders';
import { findByExternalRefTool as find } from '@/lib/mcp/tools/externalRef';
import { reserveNextDocumentNumber } from '@/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

const STATUSES = ['open', 'billed', 'cancelled', 'draft'] as const;
const batch = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sagePo(from + i, f, { status: STATUSES[i % 4], inclusive: i % 7 === 0 }));

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-import');
  other = await seedBillFixture(pool, 'po-import-other');
  await setPolicy(pool, f, 'block');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropPoDocuments(pool, x); await dropBillFixture(pool, x); }
  } finally {
    await pool.end();
  }
}, 60_000);

describe('a 100-PO Sage batch', () => {
  const sent = () => batch(197, 100);

  it('round-trips: the same numbers, the totals sent, the counter past the highest number', async () => {
    const r = await callTool(pool, f, create, { purchase_orders: sent() });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ created: 100, already_existed: 0, counter: { prefix: 'PO', next_number: 297, raised: true } });

    const listed = await callTool(pool, f, list, { limit: 200 });
    const rows = listed.body.purchase_orders as Json[];
    expect(rows.map((p) => p.po_number)).toEqual(sent().map((p) => p.po_number));
    for (const [i, p] of sent().entries()) {
      expect(rows[i]).toMatchObject({
        total: (p.expected_totals as Json).total, subtotal: (p.expected_totals as Json).subtotal, external_system: 'sage',
        external_ref: p.external_ref, line_count: 1, has_document: false,
      });
    }
    const statuses = await pool.query(
      'SELECT status, count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 GROUP BY status ORDER BY status', [f.co]);
    expect(statuses.rows).toEqual([
      { status: 'approved', n: 25 }, { status: 'cancelled', n: 25 }, { status: 'closed', n: 25 }, { status: 'draft', n: 25 },
    ]);
    const audits = await pool.query("SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order'", [f.co]);
    expect(audits.rows[0].n).toBe(100);
    // The next PO the app mints follows the imported numbers.
    expect(await asOwner(pool, f, () => reserveNextDocumentNumber(f.co, 'purchase_order'))).toBe(poNumber(297));
  }, 120_000);

  it('a re-run under a new key writes nothing and says every PO already existed', async () => {
    const r = await callTool(pool, f, create, { purchase_orders: sent() });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ created: 0, already_existed: 100 });
    expect((r.body.purchase_orders as Json[]).every((p) => p.already_existed === true && p.payload_differs === false)).toBe(true);
    expect(r.wroteNothing).toBe(true);
    expect(await poCount(pool, f)).toBe(100);
  }, 120_000);

  it('a number already in the books refuses the whole batch; nothing is written', async () => {
    const clash = { ...sagePo(200, f), external_ref: 'another-sage-id' };
    const r = await callTool(pool, f, create, { purchase_orders: [sagePo(500, f), clash] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('po_number PO0000200 already exists');
    expect(await poCount(pool, f)).toBe(100);
    expect(await counterNext(pool, f)).toBe(297); // the round-trip's mint of 297 was rolled back; the refusal moved nothing
  });

  it('a number or a reference named twice in one batch is refused before anything is read', async () => {
    const twiceNumber = await callTool(pool, f, create, { purchase_orders: [sagePo(600, f), { ...sagePo(600, f), external_ref: 'x' }] });
    expect(twiceNumber.text).toContain('po_number PO0000600 is also purchase_orders[0]');
    const twiceRef = await callTool(pool, f, create, { purchase_orders: [sagePo(601, f, { ref: 7 }), sagePo(602, f, { ref: 7 })] });
    expect(twiceRef.text).toContain('external_ref 7 is also purchase_orders[0]');
    expect(await poCount(pool, f)).toBe(100);
  });

  it('expected_totals that differ from the lines are refused, naming both figures', async () => {
    const off = { ...sagePo(700, f), expected_totals: { total: 1 } };
    const r = await callTool(pool, f, create, { purchase_orders: [off] });
    expect(r.text).toContain('expected_totals.total is 1.00 but the lines add up to');
  });

  it('find_by_external_ref finds an imported PO by its Sage id (kind po)', async () => {
    const r = await callTool(pool, f, find, { source: 'sage', kind: 'po', id: 900197 });
    expect(r.body).toMatchObject({ found: true, kind: 'purchase_order', record: { number: 'PO0000197', status: 'approved' } });
  });
});

describe('dry_run and fences', () => {
  it('dry_run reports what would be created and writes nothing: no PO, no counter move, no audit row', async () => {
    const before = { pos: await poCount(pool, other), counter: await counterNext(pool, other) };
    const r = await callTool(pool, other, create, { purchase_orders: [sagePo(5000, other, { status: 'billed' })], dry_run: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ dry_run: true, would_create: 1, counter_after: { next_number: 5001 } });
    expect((r.body.purchase_orders as Json[])[0]).toMatchObject({ id: null, po_number: 'PO0005000' });
    expect(r.wroteNothing).toBe(true);
    expect(await poCount(pool, other)).toBe(before.pos);
    expect(await counterNext(pool, other)).toBe(before.counter);
    const audits = await pool.query("SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order'", [other.co]);
    expect(audits.rows[0].n).toBe(0);
  });

  it('another company\'s supplier is "Not found" and nothing is written', async () => {
    const po = { ...sagePo(800, f), supplier_id: other.supplier };
    const r = await callTool(pool, f, create, { purchase_orders: [po] });
    expect(r).toMatchObject({ isError: true, text: 'Not found' });
    expect(await poCount(pool, f)).toBe(100);
  });

  it('another company\'s PO is invisible to list_purchase_orders and find_by_external_ref', async () => {
    const listed = await callTool(pool, other, list, { po_number: 'PO0000197' });
    expect(listed.body).toMatchObject({ total: 0, purchase_orders: [] });
    const found = await callTool(pool, other, find, { source: 'sage', kind: 'po', id: '900197' });
    expect(found.body).toMatchObject({ found: false });
  });
});
