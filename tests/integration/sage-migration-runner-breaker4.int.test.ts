/**
 * Breaker round 4, ported (r1-stale-po-differences, r2-concurrent), on a real database:
 *   - R1: a PO batch is keyed by the state of the POs it touches, as item and category batches are, so a re-run is never answered with a
 *     stored answer that was true of an earlier state: a difference the person has since fixed in IsaFlow is not reported again;
 *   - R2: one Sage migration per company at a time (a session advisory lock held for the whole run, dry runs included): a second run is
 *     refused at its start and writes nothing, so two runs cannot both claim the rows.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { migrationLockKey, RunInProgressError } from '@/modules/accounting/services/sage-migration/sageRunLock';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const run = (over: Record<string, unknown> = {}, file = exportFile()) =>
  runSageMigration(pool, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, allowRefusals: true, allowDifferences: true, ...over });
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('R1: a PO batch does not replay an answer from an earlier state of its POs', () => {
  it('a difference fixed in IsaFlow since is not reported again, and the exit is 0 without allowances', async () => {
    const first = exportFile();
    first.PurchaseOrders = posOf(first).filter((p) => p.DocumentNumber !== 'PO0000206'); // PO 206 arrives in a later export
    expect((await run({}, first)).status).toBe('completed');
    const second = exportFile();
    posOf(second)[0] = { ...posOf(second)[0], Status: 'Invoiced' }; // Sage invoiced PO197 since; PO206 is new
    const r2 = await run({}, second);
    expect(r2.differences.purchaseOrders.map((x) => x.poNumber)).toEqual(['PO0000197']);
    await pool.query(`UPDATE purchase_orders SET status = 'closed' WHERE company_id = $1 AND po_number = 'PO0000197'`, [s.companyId]); // the person closes it: books = Sage
    const r3 = await run({ allowDifferences: false, allowRefusals: false }, second);
    expect(r3.status).toBe('completed');
    expect(r3.differences.purchaseOrders).toEqual([]);
    expect(exitCodeFor(r3, false, false)).toBe(0);
    expect(r3.live!.purchaseOrders.batches[0]!.key).not.toBe(r2.live!.purchaseOrders.batches[0]!.key); // not the key run 2 stored its answer under
  });

  it('a re-run with nothing changed in IsaFlow is a fresh call that finds every PO already there, and touches nothing', async () => {
    await run();
    const stamp = async () => (await pool.query(`SELECT string_agg(id::TEXT || xmin::TEXT, ',' ORDER BY id) AS s FROM purchase_orders WHERE company_id = $1`, [s.companyId])).rows[0].s;
    const before = await stamp();
    const r = await run();
    expect(r.status).toBe('completed');
    expect(r.live!.purchaseOrders.batches[0]!.toolReported).toMatchObject({ created: 0, already_existed: 10 });
    expect(await stamp()).toBe(before);
  });

  it('a PO line linked in IsaFlow since changes the state too (the tool compares line items)', async () => {
    const inactive = exportFile();
    (inactive.Items as { $resources: Row[] }).$resources[0] = { ...(inactive.Items as { $resources: Row[] }).$resources[0], Active: false };
    await run({}, inactive); // PO197's first line goes in unlinked
    const r1 = await run({ live: false }, exportFile()); // the item is active now: the plan would link it, the stored PO has none
    expect(r1.differences.purchaseOrders.find((x) => x.poNumber === 'PO0000197')?.differences.map((d) => d.field)).toEqual(['lines[0].item_id']);
    // The person links the line by hand; the books now match what the plan would send.
    const item = (await pool.query(`SELECT id FROM items WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId])).rows[0].id;
    await pool.query(`UPDATE po_items SET item_id = $2 WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number IN ('PO0000197', 'PO0000202')) AND description LIKE 'Fibre cable drum%'`, [s.companyId, item]);
    const r2 = await run({ live: false }, exportFile());
    expect(r2.differences.purchaseOrders.filter((x) => ['PO0000197', 'PO0000202'].includes(x.poNumber))).toEqual([]);
  });
});

describe('R1 (live variant): a line linked by hand since a live run stored its answer', () => {
  it('the stored difference is not replayed: the PO batch key follows the lines, not only the header', async () => {
    const inactive = exportFile();
    (inactive.Items as { $resources: Row[] }).$resources[0] = { ...(inactive.Items as { $resources: Row[] }).$resources[0], Active: false };
    await run({}, inactive); // PO197 and PO202 go in with their FIB-0001 lines unlinked
    const r2 = await run(); // live, item active now: the plan would link them, the stored POs are unchanged: differences stored under the PO batch key
    expect(r2.differences.purchaseOrders.map((x) => x.poNumber).sort()).toEqual(['PO0000197', 'PO0000202']);
    const item = (await pool.query(`SELECT id FROM items WHERE company_id = $1 AND external_ref = '50001'`, [s.companyId])).rows[0].id;
    await pool.query(`UPDATE po_items SET item_id = $2 WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number IN ('PO0000197', 'PO0000202')) AND description LIKE 'Fibre cable drum%'`, [s.companyId, item]);
    const r3 = await run({ allowDifferences: false });
    expect(r3.status).toBe('completed');
    expect(r3.differences.purchaseOrders).toEqual([]);
  });
});

describe('R2: one run per company at a time', () => {
  const holdLock = async () => {
    const client = await pool.connect();
    const [k1, k2] = migrationLockKey(s.companyId);
    expect((await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [k1, k2])).rows[0].ok).toBe(true);
    return async () => { await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]); client.release(); };
  };

  it('while another run holds the company, a run (live or dry) is refused at its start and writes nothing', async () => {
    const release = await holdLock();
    try {
      for (const live of [true, false]) {
        const err = await run({ live }).then(() => null, (e: unknown) => e);
        expect(err, String(live)).toBeInstanceOf(RunInProgressError);
        expect((err as Error).message).toMatch(/another Sage migration is running for this company/);
      }
      expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0, toolCalls: 0 });
    } finally {
      await release();
    }
    expect((await run()).status).toBe('completed'); // the lock is free again
  });

  it('another company is not held up by it', async () => {
    const release = await holdLock();
    try {
      const other = await runSageMigration(pool, parsedExport(exportFile()), { companyId: s.otherCompanyId, userId: s.otherUserId, live: false });
      expect(other.status).not.toBeUndefined(); // it ran (its suppliers are missing, so POs are refused: that is not this test's business)
    } finally {
      await release();
    }
  });

  it('the lock is released when a run ends, whatever way: after success, after a refused start (guard), after an error', async () => {
    expect((await run()).status).toBe('completed');
    expect((await run({ live: false })).status).toBe('dry_run_ok');
    await run({ userId: s.otherUserId }).then(() => null, () => null); // not a member: thrown after the lock was taken
    expect((await run({ live: false })).status).toBe('dry_run_ok');
  });

  it('two runs started together never both claim the rows: what they say they added sums to what is in the books', async () => {
    const [a, b] = await Promise.allSettled([run(), run({ itemBatchSize: 7, poBatchSize: 3 })]);
    const added = [a, b].reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.reconciliation.items.addedByRun : 0), 0);
    expect(added).toBe(20);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
    for (const r of [a, b]) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(RunInProgressError);
  });
});
