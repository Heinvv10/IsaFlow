/**
 * Round-5 findings on a real database:
 *   - M2: the run lock is watched: if its connection is killed mid-run the run stops (MigrationStopped "lock lost", the committed
 *     batches listed) at the next phase boundary instead of going on unprotected;
 *   - L3: with --allow-differences, a PO already booked with another total is a listed difference, not a booking that went missing;
 *   - L4: after a live run, the not-linked list and the PDF list name only POs that are in the books;
 *   - L7: the runner never debits Flows: a PAYG company's wallet is the same after a dry run and a live run.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { migrationLockKey } from '@/modules/accounting/services/sage-migration/sageRunLock';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const run = (over: Record<string, unknown> = {}, file = exportFile(), p: Pool = pool) =>
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, allowRefusals: true, allowDifferences: true, ...over });
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('M2: the run lock is watched', () => {
  const killLock = async () => {
    const [k1, k2] = migrationLockKey(s.companyId);
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted`,
      [String(BigInt.asUintN(32, BigInt(k1))), String(BigInt.asUintN(32, BigInt(k2)))]);
    await new Promise((r) => setTimeout(r, 150)); // let the server drop it and the client see it
  };
  const stoppedAfter = async (tool: string): Promise<MigrationStopped> => {
    const err = await run({}, exportFile(), afterCommitOf(pool, tool, { after: killLock })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    expect((err as MigrationStopped).liveStarted).toBe(true);
    expect((err as MigrationStopped).message).toMatch(/lock lost/);
    return err as MigrationStopped;
  };

  it('killed after the category batches: the run stops before the items phase, the committed batches listed', async () => {
    const stopped = await stoppedAfter('upsert_item_category');
    expect(stopped.committed.map((b) => b.entity)).toContain('category');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, pos: 0 });
  });

  it('killed after the items batch: the run stops before the PO phase', async () => {
    const stopped = await stoppedAfter('bulk_upsert_items');
    expect(stopped.committed.map((b) => b.entity)).toContain('item');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 0 });
  });

  it('killed after the PO batches: the run stops before its final reading, the POs are committed and listed', async () => {
    const stopped = await stoppedAfter('bulk_create_purchase_orders');
    expect(stopped.committed.map((b) => b.entity)).toContain('purchase_order');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
  });

  it('with nothing killed the same run completes (the watch is no false alarm)', async () => {
    expect((await run()).status).toBe('completed');
  });
});

describe('L3: --allow-differences and a PO booked with another total', () => {
  it('the run is complete (exit 0 with the allowance): the difference is listed, the booked total stays as it was', async () => {
    await run();
    const f = exportFile();
    const po = posOf(f)[0]!; // PO0000197: its first line goes from 1200 to 1300 a unit, so Sage's total is R230 more
    const lines = po.Lines as Row[];
    lines[0] = { ...lines[0], UnitPriceExclusive: 1300, Exclusive: 2600, Tax: 390 };
    posOf(f)[0] = { ...po, Lines: lines, Exclusive: (po.Exclusive as number) + 200, Tax: (po.Tax as number) + 30, Total: (po.Total as number) + 230 };
    const r = await run({}, f);
    expect(r.status).toBe('completed');
    expect(r.differences.purchaseOrders.find((x) => x.poNumber === 'PO0000197')!.differences.map((d) => d.field)).toContain('total');
    expect(r.reconciliation.purchaseOrders.differenceCents).toBe(23000); // honest: Sage says R230 more than the books hold
    expect(r.reconciliation.allSentBooked).toBe(true);
    expect(exitCodeFor(r, false, true)).toBe(0);
    expect(exitCodeFor(r, false, false)).toBe(1); // without the allowance the difference still fails the exit
    expect((await run({ allowDifferences: false }, f)).status).toBe('live_blocked'); // not allowed: the live run does not even start
  });
});

describe('L4: after a live run only POs that are in the books are listed', () => {
  it('a failed PO batch: its POs are not in the not-linked list or the PDF list', async () => {
    const f = exportFile();
    rowsOf(f)[0] = { ...rowsOf(f)[0], Active: false }; // lines naming 50001 (PO0000197 and PO0000202) go in unlinked
    // Commits: 1-4 categories, 5 items, 6-9 the PO batches of 3 (197-199, 200-202, 203-205, 206): batch 2 holds PO0000202.
    const r = await run({ poBatchSize: 3 }, f, failingCommitPool(pool, [7]));
    expect(r.status).toBe('failed');
    expect(r.lineLinks.notLinked.map((x) => x.poNumber)).toEqual(['PO0000197']);
    expect(r.reconciliation.attachments.posWithPdf).toBe(7);
    expect(r.reconciliation.attachments.files.map((x) => x.poNumber)).not.toContain('PO0000202');
  });
});

describe('L7: Flows', () => {
  it('a PAYG company\'s wallet is unchanged by a dry run and by a live run (every tool the runner calls is free)', async () => {
    const plan = String((await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ('payg', 'PAYG (sage-migration test)', 0) RETURNING id`)).rows[0].id);
    try {
      await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status) VALUES ($1, $2, 'active')`, [s.companyId, plan]);
      await pool.query(`INSERT INTO flow_wallet (company_id, balance_flows) VALUES ($1, 50)`, [s.companyId]);
      const wallet = async () => (await pool.query('SELECT balance_flows, month_flows_used FROM flow_wallet WHERE company_id = $1', [s.companyId])).rows[0];
      await run({ live: false });
      expect(await wallet()).toEqual({ balance_flows: 50, month_flows_used: 0 });
      expect((await run()).status).toBe('completed');
      expect(await wallet()).toEqual({ balance_flows: 50, month_flows_used: 0 });
    } finally {
      await pool.query('DELETE FROM flow_wallet WHERE company_id = $1', [s.companyId]);
      await pool.query('DELETE FROM subscriptions WHERE company_id = $1', [s.companyId]);
      await pool.query('DELETE FROM plans WHERE id = $1', [plan]);
    }
  });
});
