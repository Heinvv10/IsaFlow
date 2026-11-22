/**
 * Sage migration runner: re-runs, failures and refusals, against a real database through the real MCP registry.
 *   - a re-run of the same export under the same keys replays and changes nothing; a re-run under NEW keys (other batch sizes)
 *     is still a no-op, because the tools are idempotent on the Sage reference;
 *   - a batch whose COMMIT fails is not in the books; the other batches of its phase still run, the next phase does not start,
 *     and running again finishes the job (resume), the finished batches replaying under the same keys;
 *   - rows no tool could take are refused BEFORE sending, with reasons, and the rest of the file goes through;
 *   - a refusal only the database can give (a PO number already taken, a code held by another item) fails the DRY run, and
 *     then nothing at all is written, even when live was asked for (the tools refuse a whole batch for one row).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, stamps, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;

beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const run = (over: Record<string, unknown> = {}, file = exportFile(), p: Pool = pool) =>
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, ...over });
type Row = Record<string, unknown>;
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('a re-run', () => {
  it('under the same keys replays every batch and touches no row', async () => {
    const first = await run();
    expect(first.status).toBe('completed');
    const afterFirst = { counts: await booked(pool, s.companyId), stamps: await stamps(pool, s.companyId) };
    const again = await run();
    expect(again.status).toBe('completed');
    expect(again.reconciliation).toMatchObject({ items: { presentBefore: 20, addedByRun: 0 }, purchaseOrders: { presentBefore: 10, addedByRun: 0 }, allSentBooked: true, nothingRefused: true });
    const batches = [...again.live!.items.batches, ...again.live!.purchaseOrders.batches];
    expect(batches.every((b) => b.allRowsAlreadyPresent && b.status === 'ok')).toBe(true);
    expect(batches.map((b) => b.key)).toEqual([...first.live!.items.batches, ...first.live!.purchaseOrders.batches].map((b) => b.key));
    // A replay records nothing: not one new audit row, not one row touched.
    expect(await booked(pool, s.companyId)).toEqual(afterFirst.counts);
    expect(await stamps(pool, s.companyId)).toEqual(afterFirst.stamps);
  });

  it('under NEW keys (other batch sizes) still adds nothing: the Sage reference is the idempotency', async () => {
    await run();
    const before = { counts: await booked(pool, s.companyId), stamps: await stamps(pool, s.companyId) };
    const again = await run({ itemBatchSize: 7, poBatchSize: 3 });
    expect(again.status).toBe('completed');
    expect(again.live!.items.batches).toHaveLength(3);
    expect(again.live!.purchaseOrders.batches).toHaveLength(4);
    expect(again.live!.items.batches[0]!.toolReported).toMatchObject({ counts: { created: 0, updated: 0, unchanged: 7 }, written: false });
    expect(again.live!.purchaseOrders.batches[0]!.toolReported).toMatchObject({ created: 0, already_existed: 3 });
    expect(again.reconciliation).toMatchObject({ items: { addedByRun: 0 }, purchaseOrders: { addedByRun: 0, differenceCents: 0 }, allSentBooked: true, nothingRefused: true });
    const now = await booked(pool, s.companyId);
    expect({ ...now, toolCalls: 0 }).toEqual({ ...before.counts, toolCalls: 0 });
    expect(await stamps(pool, s.companyId)).toEqual(before.stamps);
  });

  it('with skip_budget_check_for_import asked, passes it to the PO tool and still completes', async () => {
    const r = await run({ skipBudgetCheck: true });
    expect(r.status).toBe('completed');
    expect(r.live!.purchaseOrders.batches[0]!.toolReported).toMatchObject({ skip_budget_check_for_import: true, created: 10 });
  });
});

describe('a failed batch', () => {
  it('a PO batch whose COMMIT fails is not booked; its neighbours are; running again finishes it', async () => {
    // Commits: 1-4 categories, 5 the one item batch, 6-9 the PO batches of 3 (197-199, 200-202, 203-205, 206).
    const first = await run({ poBatchSize: 3 }, exportFile(), failingCommitPool(pool, [7]));
    expect(first.status).toBe('failed');
    expect(first.live!.purchaseOrders.batches.map((b) => b.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(first.live!.purchaseOrders.batches[1]!.error).toMatch(/injected: COMMIT 7 failed/);
    const poNumbers = (await pool.query('SELECT po_number FROM purchase_orders WHERE company_id = $1 ORDER BY po_number', [s.companyId])).rows.map((r) => r.po_number);
    expect(poNumbers).toEqual(['PO0000197', 'PO0000198', 'PO0000199', 'PO0000203', 'PO0000204', 'PO0000205', 'PO0000206']);
    expect(first.reconciliation).toMatchObject({ allSentBooked: false, purchaseOrders: { presentAfter: 7, addedByRun: 7 } });
    expect(first.reconciliation.purchaseOrders.differenceCents).toBeGreaterThan(0);
    expect(summaryLines(first).some((l) => l.startsWith('FAILED purchase_order batch 2'))).toBe(true);

    const resumed = await run({ poBatchSize: 3 });
    expect(resumed.status).toBe('completed');
    expect(resumed.live!.purchaseOrders.batches.map((b) => b.allRowsAlreadyPresent)).toEqual([true, false, true, true]);
    expect(resumed.live!.purchaseOrders.batches.map((b) => b.key)).toEqual(first.live!.purchaseOrders.batches.map((b) => b.key));
    expect(resumed.reconciliation).toMatchObject({ allSentBooked: true, purchaseOrders: { presentBefore: 7, presentAfter: 10, addedByRun: 3, differenceCents: 0 } });
    expect((await booked(pool, s.companyId)).pos).toBe(10);
  });

  it('a failed item batch keeps the purchase orders from starting; categories stay; running again finishes', async () => {
    const first = await run({}, exportFile(), failingCommitPool(pool, [5]));
    expect(first.status).toBe('failed');
    expect(first.live!.categories.failed).toBe(0);
    expect(first.live!.items.batches.map((b) => b.status)).toEqual(['failed']);
    expect(first.live!.purchaseOrders.batches).toEqual([]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0, pos: 0 });
    const resumed = await run();
    expect(resumed.status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 10 });
  });

  it('a failed category keeps the items from starting, the other categories still run', async () => {
    const first = await run({}, exportFile(), failingCommitPool(pool, [2]));
    expect(first.status).toBe('failed');
    expect(first.live!.categories.batches.map((b) => b.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(first.live!.items.batches).toEqual([]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 3, items: 0, pos: 0 });
    expect((await run()).status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 10 });
  });
});

describe('rows refused before sending', () => {
  it('are reported with reasons and the rest of the file is booked', async () => {
    const file = exportFile();
    rowsOf(file)[2] = { ...rowsOf(file)[2], TaxTypeIdSales: 9 }; // FIB-0003: tax type unknown
    posOf(file)[1] = { ...posOf(file)[1], SupplierId: 999, SupplierName: 'Nobody Ltd' }; // no such supplier
    posOf(file)[2] = { ...posOf(file)[2], Exclusive: (posOf(file)[2]!.Exclusive as number) + 100, Total: (posOf(file)[2]!.Total as number) + 100 }; // lines do not add up
    posOf(file)[4] = { ...posOf(file)[4], SupplierId: 888, SupplierName: 'Dup Co' }; // two suppliers of that name
    for (let i = 0; i < 2; i++) await pool.query('INSERT INTO suppliers (company_id, name) VALUES ($1, $2)', [s.companyId, 'Dup Co']);
    const parsed = parsedExport(file);

    // What the export holds is not what was booked: asked to expect the export's own figures, the run says it missed them.
    const r = await run({ expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: parsed.exportPoTotalCents } }, file);
    expect(r.status).toBe('completed');
    expect(r.reconciliation.expected).toMatchObject({
      items: { expected: 20, actual: 19, basis: 'booked', ok: false }, purchaseOrders: { expected: 10, actual: 7, ok: false },
      purchaseOrderTotalCents: { ok: false },
    });
    expect(exitCodeFor(r, true)).toBe(1); // allowed refusals do not excuse a missed expectation
    expect(summaryLines(r).filter((l) => l.startsWith('MISMATCH'))).toHaveLength(3);
    expect(r.refused.map((x) => [x.entity, x.label, x.code]).sort()).toEqual([
      ['item', 'FIB-0003', 'invalid_row'],
      ['purchase_order', 'PO0000198', 'supplier_unresolved'],
      ['purchase_order', 'PO0000199', 'tool_refuses'],
      ['purchase_order', 'PO0000201', 'supplier_ambiguous'],
    ]);
    expect(r.refused.find((x) => x.label === 'PO0000199')!.reasons[0]).toMatch(/subtotal/i);
    expect(r.refused.find((x) => x.label === 'FIB-0003')!.reasons[0]).toMatch(/TaxTypeIdSales 9/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 19, pos: 7 });
    const rec = r.reconciliation;
    expect(rec.items).toMatchObject({ inExport: 20, refused: 1, sent: 19, presentAfter: 19 });
    expect(rec.purchaseOrders).toMatchObject({ inExport: 10, refused: 3, sent: 7, presentAfter: 7, differenceCents: 0 });
    expect(rec.purchaseOrders.sentTotalCents + rec.purchaseOrders.notSentTotalCents).toBe(rec.purchaseOrders.exportTotalCents);
    expect(rec.purchaseOrders.notSentTotalCents).toBeGreaterThan(0);
    expect([rec.allSentBooked, rec.nothingRefused]).toEqual([true, false]); // everything sent is booked; four rows were not sent
    expect(summaryLines(r).filter((l) => l.startsWith('refused '))).toHaveLength(4);
    expect(exitCodeFor(r, false)).toBe(1);
  });
});

describe('F1: an item the migration did not import is never updated', () => {
  it('a tracked item with stock and the same code, no reference: untouched, the Sage row refused naming it, the rest booked', async () => {
    const id = String((await pool.query(
      `INSERT INTO items (company_id, code, description, item_type, inventory_tracked, opening_qty, current_qty, opening_cost, cost_price, selling_price_excl, unit)
       VALUES ($1, 'FIB-0001', 'Real stocked item', 'physical', true, 50, 50, 12.5, 12.5, 30, 'box') RETURNING id`, [s.companyId])).rows[0].id);
    const before = (await pool.query('SELECT * FROM items WHERE id = $1', [id])).rows[0];
    const file = exportFile();
    rowsOf(file)[0] = { ...rowsOf(file)[0], Physical: false, LastCost: 1, PriceExclusive: 2 }; // the Sage row would turn it into a service
    const r = await run({}, file);
    expect((await pool.query('SELECT * FROM items WHERE id = $1', [id])).rows[0]).toEqual(before);
    expect(r.refused.find((x) => x.entity === 'item')).toMatchObject({ label: 'FIB-0001', code: 'code_held_by_existing_item' });
    expect(r.refused.find((x) => x.entity === 'item')!.reasons[0]).toContain(id);
    expect(r.reconciliation.items).toMatchObject({ refused: 1, sent: 19, presentAfter: 19 });
    expect(exitCodeFor(r, false)).toBe(1);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20 });
  });

  it('an INACTIVE Sage row with the code of a live item does not deactivate it', async () => {
    const id = String((await pool.query(
      `INSERT INTO items (company_id, code, description, item_type, inventory_tracked, is_active, current_qty, opening_qty)
       VALUES ($1, 'FIB-0007', 'Live item', 'physical', true, true, 12, 12) RETURNING id`, [s.companyId])).rows[0].id);
    const r = await run(); // the fixture's FIB-0007 is inactive in Sage
    const after = (await pool.query('SELECT is_active, inventory_tracked, current_qty FROM items WHERE id = $1', [id])).rows[0];
    expect(after).toMatchObject({ is_active: true, inventory_tracked: true });
    expect(Number(after.current_qty)).toBe(12);
    expect(r.refused.map((x) => [x.label, x.code])).toEqual([['FIB-0007', 'code_held_by_existing_item']]);
  });

  it('the migration\'s OWN item is updated: a changed Sage price reaches it', async () => {
    await run();
    const file = exportFile();
    rowsOf(file)[0] = { ...rowsOf(file)[0], PriceExclusive: 999.99 };
    const r = await run({}, file);
    expect(r.refused).toEqual([]);
    expect(Number((await pool.query(`SELECT selling_price_excl AS p FROM items WHERE company_id = $1 AND code = 'FIB-0001'`, [s.companyId])).rows[0].p)).toBe(999.99);
  });
});

describe('F3: a supplier with another Sage reference is not matched by name', () => {
  it('the PO of that Sage supplier is refused supplier_ref_conflict, not booked to the other supplier', async () => {
    // Sage supplier 302 is "Bravo Poles CC" here; IsaFlow\'s Bravo already is Sage supplier 777.
    await pool.query(`UPDATE suppliers SET external_system = 'sage', external_ref = '777' WHERE id = $1`, [s.suppliers.bravo]);
    const r = await run();
    expect(r.refused.filter((x) => x.entity === 'purchase_order').map((x) => x.code)).toEqual(['supplier_ref_conflict', 'supplier_ref_conflict', 'supplier_ref_conflict']);
    expect(r.refused[0]!.reasons[0]).toMatch(/Sage supplier 777/);
    expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 AND supplier_id = $2', [s.companyId, s.suppliers.bravo])).rows[0].n).toBe(0);
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 7 });
  });
});

describe('F5: rows deleted after a run', () => {
  const wipe = async () => {
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [s.companyId]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM items WHERE company_id = $1', [s.companyId]);
  };

  it('a re-run replays the old answers, says "replayed, rows absent", fails and names --run-tag; the tag imports afresh', async () => {
    expect((await run()).status).toBe('completed');
    await wipe();
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, pos: 0 });

    const stale = await run();
    expect(stale.status).toBe('failed');
    const bad = [...stale.live!.items.batches, ...stale.live!.purchaseOrders.batches];
    expect(bad.every((b) => b.status === 'failed' && b.rowsAbsent === b.size)).toBe(true);
    expect(bad[0]!.error).toMatch(/replayed, rows absent: 20 of 20 rows/);
    expect(bad[0]!.error).toMatch(/--run-tag/);
    expect(stale.reconciliation.allSentBooked).toBe(false);
    expect(summaryLines(stale).join('\n')).toMatch(/replayed, rows absent/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, pos: 0 });

    const fresh = await run({ runTag: 'again1' });
    expect(fresh.status).toBe('completed');
    expect(fresh.live!.items.batches[0]!.key).not.toBe(stale.live!.items.batches[0]!.key);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
    // The same tag again is a re-run like any other: it replays and changes nothing.
    const again = await run({ runTag: 'again1' });
    expect(again.status).toBe('completed');
    expect(again.live!.items.batches[0]!.key).toBe(fresh.live!.items.batches[0]!.key);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
  });

  it('a batch that is simply written is never called absent, and an untagged key is unchanged by the feature', async () => {
    const r = await run();
    expect([...r.live!.items.batches, ...r.live!.purchaseOrders.batches].every((b) => b.rowsAbsent === 0)).toBe(true);
    expect(r.live!.items.batches[0]!.key).toMatch(/^sage-mig-item-0001-[0-9a-f]{16}$/);
  });
});

describe('what the company already holds', () => {
  it('with the figures that were sent and booked, and refusals allowed, the exit is 0; without the allowance it is 1', async () => {
    const file = exportFile();
    rowsOf(file)[2] = { ...rowsOf(file)[2], TaxTypeIdSales: 9 };
    const r = await run({ expect: { items: 19, purchaseOrders: 10 } }, file);
    expect(r.reconciliation.expected).toMatchObject({ items: { actual: 19, ok: true }, purchaseOrders: { actual: 10, ok: true } });
    expect(exitCodeFor(r, true)).toBe(0);
    expect(exitCodeFor(r, false)).toBe(1);
  });

  it('a PO number another PO carries is refused for that PO alone, with its reason; the rest is booked', async () => {
    await pool.query(
      `INSERT INTO purchase_orders (company_id, supplier_id, po_number, order_date, status, subtotal, tax_amount, total)
       VALUES ($1, $2, 'PO0000203', '2026-01-01', 'draft', 0, 0, 0)`, [s.companyId, s.suppliers.alpha]);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused).toEqual([expect.objectContaining({ entity: 'purchase_order', label: 'PO0000203', code: 'po_number_taken' })]);
    expect(r.refused[0]!.reasons[0]).toMatch(/PO0000203 already belongs to a purchase order \(no external reference\)/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 }); // 9 imported + the one that was there
    expect(r.reconciliation).toMatchObject({ allSentBooked: true, nothingRefused: false, purchaseOrders: { refused: 1, sent: 9, presentAfter: 9 } });
    expect(exitCodeFor(r, false)).toBe(1);
  });

  it('a code held by an item with another Sage reference is refused for that item, and so are the POs naming it', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, external_system, external_ref) VALUES ($1, 'FIB-0001', 'someone else', 'sage', '1')`, [s.companyId]);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused.filter((x) => x.entity === 'item').map((x) => [x.label, x.code])).toEqual([['FIB-0001', 'code_held_by_existing_item']]);
    expect(r.refused.filter((x) => x.entity === 'purchase_order').map((x) => [x.label, x.code])).toEqual([['PO0000197', 'line_item_refused'], ['PO0000202', 'line_item_refused']]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 8 }); // 19 imported + the one that was there
  });

  it('a DELETED item with the code is read from the books too: item_deleted for that row, the rest booked', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, external_system, external_ref, deleted_at) VALUES ($1, 'FIB-0004', 'gone', 'sage', '50004', now())`, [s.companyId]);
    const r = await run();
    expect(r.refused.filter((x) => x.entity === 'item').map((x) => [x.label, x.code])).toEqual([['FIB-0004', 'item_deleted']]);
    expect(r.refused[0]!.reasons[0]).toMatch(/has been deleted/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 }); // 19 imported + the deleted one still in the table
  });

  it('nothing is sent for a row the company\'s data would make a tool refuse: the whole file still goes through the dry run clean', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, external_system, external_ref) VALUES ($1, 'FIB-0002', 'someone else', 'pastel', '77')`, [s.companyId]);
    const r = await run({ live: false });
    expect(r.status).toBe('dry_run_ok');
    expect(r.dryRun.clean).toBe(true);
    expect(r.refused.map((x) => x.code)).toContain('code_held_by_existing_item');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 1, pos: 0, categories: 0, toolCalls: 0 });
  });
});
