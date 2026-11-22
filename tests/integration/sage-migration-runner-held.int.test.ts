/**
 * Sage migration runner against what the company already holds, and rows deleted after a run, on a real database:
 *   - F1: an item the migration did not import is never updated (the breaker's tracked-item and inactive-row repros);
 *   - F3: a supplier carrying another Sage reference is not matched by name;
 *   - F5: rows deleted after a run: the replay says "replayed, rows absent"; --run-tag imports afresh;
 *   - a category name IsaFlow holds, a PO number another PO carries, a deleted item: refused per row, the dry run stays clean.
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
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, ...over });
type Row = Record<string, unknown>;
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

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

describe('a category name IsaFlow already holds', () => {
  it('the category and its items are refused per row, the dry run stays clean, the holder is untouched, the rest is booked', async () => {
    const id = String((await pool.query(`INSERT INTO item_categories (company_id, name) VALUES ($1, 'optics') RETURNING id`, [s.companyId])).rows[0].id);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    expect(dry.dryRun.clean).toBe(true);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused.filter((x) => x.entity === 'category')).toEqual([expect.objectContaining({ label: 'Optics', code: 'category_name_in_use' })]);
    expect(r.refused.find((x) => x.entity === 'category')!.reasons[0]).toContain(id);
    const items = r.refused.filter((x) => x.entity === 'item');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((x) => x.code === 'category_refused')).toBe(true);
    expect(await pool.query('SELECT name, external_ref FROM item_categories WHERE id = $1', [id])).toHaveProperty('rows', [{ name: 'optics', external_ref: null }]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20 - items.length });
    expect(r.reconciliation).toMatchObject({ allSentBooked: true, nothingRefused: false });
    expect(exitCodeFor(r, false)).toBe(1);
    expect(exitCodeFor(r, true)).toBe(0); // refusals allowed, nothing else wrong
  });
});

describe('#10: external_system is compared exactly as the item and category tools do (case-sensitive "sage")', () => {
  it('B1d: an item stored with external_system "Sage" is not owned: its row is refused per row, the dry run stays clean', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, item_type, external_system, external_ref) VALUES ($1, 'FIB-0001', 'x', 'physical', 'Sage', '50001')`, [s.companyId]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused.filter((x) => x.entity === 'item').map((x) => [x.label, x.code])).toEqual([['FIB-0001', 'code_held_by_existing_item']]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 }); // 19 + the one that was there; the POs naming FIB-0001 go with that line unlinked
  });
  it('B1c: a category stored with external_system "Sage" is not owned: refused category_name_in_use, its items category_refused, dry run clean', async () => {
    await pool.query(`INSERT INTO item_categories (company_id, name, external_system, external_ref) VALUES ($1, 'Optics', 'Sage', '10')`, [s.companyId]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.refused.find((x) => x.entity === 'category')).toMatchObject({ label: 'Optics', code: 'category_name_in_use' });
    expect(r.refused.filter((x) => x.entity === 'item').every((x) => x.code === 'category_refused')).toBe(true);
  });
  it('an item stored with exactly "sage" is the migration\'s own (updated, not refused)', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, item_type, external_system, external_ref) VALUES ($1, 'FIB-0001', 'x', 'physical', 'sage', '50001')`, [s.companyId]);
    const r = await run();
    expect(r.refused).toEqual([]);
  });
});

describe('#11: an owned item with stock movements keeps its type and tracking', () => {
  it('a tracked owned item with movements: the Sage row is refused per row, nothing is changed', async () => {
    const item = String((await pool.query(
      `INSERT INTO items (company_id, code, description, item_type, inventory_tracked, external_system, external_ref)
       VALUES ($1, 'FIB-0001', 'x', 'physical', true, 'sage', '50001') RETURNING id`, [s.companyId])).rows[0].id);
    const product = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'P-1', 'P') RETURNING id`, [s.companyId])).rows[0].id);
    await pool.query(`INSERT INTO stock_movements (company_id, product_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'purchase', 5)`, [s.companyId, product, item]);
    const dry = await run({ live: false });
    expect(dry.status).toBe('dry_run_ok');
    const r = await run();
    expect(r.refused.filter((x) => x.entity === 'item')).toEqual([expect.objectContaining({ label: 'FIB-0001', code: 'item_has_stock_movements' })]);
    expect((await pool.query('SELECT inventory_tracked, item_type FROM items WHERE id = $1', [item])).rows[0]).toEqual({ inventory_tracked: true, item_type: 'physical' });
    await pool.query('DELETE FROM stock_movements WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM products WHERE company_id = $1', [s.companyId]);
  });
});

describe('#1: an owned-ness the snapshot got wrong is caught by the dry run, before anything is written', () => {
  /** A pool whose Nth connect() first runs `hook` (a writer landing between the runner's reads). */
  const hooked = (nth: number, hook: () => Promise<void>): Pool => {
    let n = 0;
    return { options: pool.options, connect: async () => { n++; if (n === nth) await hook(); return pool.connect(); } } as unknown as Pool;
  };

  it('a human-made item with an export code appears AFTER the snapshot: the dry run fails naming the row, the item is untouched, live writes nothing', async () => {
    // connect 1 = the snapshot's read session, connect 2 = the dry run: the item lands between them.
    const p2 = hooked(2, async () => {
      await pool.query(`INSERT INTO items (company_id, code, description, item_type, inventory_tracked, selling_price_excl) VALUES ($1, 'FIB-0001', 'HUMAN MADE', 'physical', true, 500)`, [s.companyId]);
    });
    const r = await run({}, exportFile(), p2);
    expect(r.status).toBe('dry_run_failed');
    expect(r.live).toBeNull();
    expect(r.dryRun.items.batches[0]!.error).toMatch(/row 0 \(FIB-0001, Sage id 50001\) came back updated, but it is not an item this migration owns/);
    expect((await pool.query(`SELECT description, item_type, inventory_tracked, selling_price_excl FROM items WHERE company_id = $1`, [s.companyId])).rows)
      .toEqual([{ description: 'HUMAN MADE', item_type: 'physical', inventory_tracked: true, selling_price_excl: '500.00' }]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 1, categories: 0, pos: 0, toolCalls: 0 });
  });

  it('with nothing landing in between, the same run is clean (the check is not a false alarm on a re-run of owned items)', async () => {
    await run();
    const r = await run({ live: false });
    expect(r.status).toBe('dry_run_ok');
  });
});

describe('#8: replayed categories whose rows are gone', () => {
  it('after the rows were deleted, the categories batches say "replayed, rows absent" like items and POs do; --run-tag imports afresh', async () => {
    await run();
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [s.companyId]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM items WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM item_categories WHERE company_id = $1', [s.companyId]);
    const stale = await run();
    expect(stale.status).toBe('failed');
    const cats = stale.live!.categories.batches;
    expect(cats).toHaveLength(4);
    expect(cats.every((b) => b.status === 'failed' && b.rowsAbsent === 1)).toBe(true);
    expect(cats[0]!.error).toMatch(/replayed, rows absent: 1 of 1 rows/);
    expect(cats[0]!.error).toMatch(/--run-tag/);
    const fresh = await run({ runTag: 'again2' });
    expect(fresh.status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 10 });
  });
});

describe('a PO of an inactive supplier', () => {
  it('is refused supplier_inactive per row; the other suppliers\' POs are booked', async () => {
    await pool.query('UPDATE suppliers SET is_active = false WHERE id = $1', [s.suppliers.bravo]);
    const r = await run();
    expect(r.refused.filter((x) => x.entity === 'purchase_order').map((x) => x.code)).toEqual(['supplier_inactive', 'supplier_inactive', 'supplier_inactive']);
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 7 });
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

  it('a code held by an item with another Sage reference is refused for that item; the POs naming it are booked, those lines unlinked', async () => {
    await pool.query(`INSERT INTO items (company_id, code, description, external_system, external_ref) VALUES ($1, 'FIB-0001', 'someone else', 'sage', '1')`, [s.companyId]);
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.refused.filter((x) => x.entity === 'item').map((x) => [x.label, x.code])).toEqual([['FIB-0001', 'code_held_by_existing_item']]);
    expect(r.refused.filter((x) => x.entity === 'purchase_order')).toEqual([]);
    expect(r.lineLinks.notLinked.map((x) => [x.poNumber, x.itemCode, x.reason])).toEqual([['PO0000197', 'FIB-0001', 'refused'], ['PO0000202', 'FIB-0001', 'refused']]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 }); // 19 imported + the one that was there
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
