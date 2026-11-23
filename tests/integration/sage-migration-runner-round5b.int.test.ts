/**
 * Round-5 breaker findings on a real database:
 *   - B5-A3/B2: a lost run lock is noticed (a second run that started in the gap does not make two runs claim the rows); the lock session is
 *     kept from idling out (idle_session_timeout), so a long CLI run finishes and reports;
 *   - B5-C2: a re-run lists what the PO tool does not compare (supplier, delivery date, reference, lines) as a difference;
 *   - B5-E1: a deleted supplier carrying the Sage reference is never booked to;
 *   - B5-G: a pool of one connection is refused, it does not hang.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
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
const opts = (over: Record<string, unknown> = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, ...over });
const run = (file: Row = exportFile(), over: Record<string, unknown> = {}, p: Pool = pool) => runSageMigration(p, parsedExport(file), opts(over));
const posOf = (file: Row) => file.PurchaseOrders as Row[];

describe('B5-A3: a lost run lock', () => {
  it('killed after the first batch while a second run starts in the gap: the first run stops, the second completes, nothing is claimed twice', async () => {
    const [k1, k2] = migrationLockKey(s.companyId);
    let second: Awaited<ReturnType<typeof run>> | null = null;
    const hooked = afterCommitOf(pool, 'upsert_item_category', {
      after: async () => {
        await pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted`,
          [String(BigInt.asUintN(32, BigInt(k1))), String(BigInt.asUintN(32, BigInt(k2)))]);
        await new Promise((r) => setTimeout(r, 150));
        second = await run();
      },
    });
    const err = await run(exportFile(), {}, hooked).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    expect((err as MigrationStopped).message).toMatch(/lock lost/);
    expect((err as MigrationStopped).committed.map((b) => b.entity)).not.toContain('item'); // stopped at the next boundary, before its items phase
    expect(second).not.toBeNull();
    expect(second!.status).toBe('completed');
    expect(second!.reconciliation.items.addedByRun).toBe(20);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10, categories: 4 });
  });
});

describe('B5-B2: the CLI holds its lock through a server that ends idle sessions', () => {
  it('idle_session_timeout of 1.5 s and 400 ms commits: the run completes, reports and exits 0', async () => {
    const r = spawnSync('bun', ['--no-env-file', '--preload', join(process.cwd(), 'tests/integration/helpers/sageSlowCommitsPreload.ts'),
      'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
      '--live', '--expect-items', '20', '--expect-pos', '10'], {
      encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', PGOPTIONS: '-c idle_session_timeout=1500', SAGE_COMMIT_DELAY_MS: '400' },
    });
    expect(r.stdout).toMatch(/completed/);
    expect(r.status).toBe(0);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, categories: 4, pos: 10 });
  }, 180_000);
});

describe('B5-C2: a re-run compares what the PO tool does not', () => {
  const moved = (): Row => {
    const f = exportFile();
    const po = posOf(f)[0]!; // PO0000197
    const lines = po.Lines as Row[];
    posOf(f)[0] = {
      ...po, SupplierId: 302, SupplierName: 'Bravo Poles CC', DeliveryDate: '2026-03-31', Reference: 'JOB-999',
      Lines: [lines[0], { ...lines[1], Description: 'Delivery charge x2 (half price)', Quantity: 2, UnitPriceExclusive: (lines[1]!.UnitPriceExclusive as number) / 2, Exclusive: lines[1]!.Exclusive, Tax: lines[1]!.Tax }, lines[2]],
    };
    return f;
  };

  it('Sage moved PO197 to another supplier, changed its date and reference and restructured a line at the same total: listed, and the live run is blocked without --allow-differences', async () => {
    expect((await run()).status).toBe('completed');
    const r = await run(moved(), { allowDifferences: false, allowRefusals: false });
    const fields = r.differences.purchaseOrders.find((x) => x.poNumber === 'PO0000197')?.differences.map((d) => d.field) ?? [];
    expect(fields).toEqual(expect.arrayContaining(['supplier_id', 'expected_delivery_date', 'reference', 'line 2 description', 'line 2 quantity', 'line 2 unit_price']));
    expect(r.status).toBe('live_blocked');
    expect(exitCodeFor(r, false, false)).toBe(1);
  });

  it('with --allow-differences it goes on and exits 0; the books keep the supplier and lines they had (an existing PO is never rewritten)', async () => {
    await run();
    const r = await run(moved());
    expect(r.status).toBe('completed');
    expect(r.differences.purchaseOrders.map((x) => x.poNumber)).toEqual(['PO0000197']);
    expect(exitCodeFor(r, false, true)).toBe(0);
    const stored = (await pool.query(`SELECT supplier_id::TEXT AS supplier, reference FROM purchase_orders WHERE company_id = $1 AND po_number = 'PO0000197'`, [s.companyId])).rows[0];
    expect(stored.supplier).toBe(s.suppliers.alpha);
    expect(stored.reference).not.toBe('JOB-999');
  });

  it('an unchanged export re-run has no difference at all (no false alarm from the added comparison)', async () => {
    await run();
    const r = await run(exportFile(), { allowDifferences: false, allowRefusals: false });
    expect(r.differences).toEqual({ purchaseOrders: [], items: [], categories: [] });
    expect(r.status).toBe('completed');
  });

  it('a line whose item was inactive on the first run (unlinked, " [item CODE]" suffix) and active now: only the tool\'s own link difference, no description difference from the suffix', async () => {
    const f = exportFile();
    (f.Items as { $resources: Row[] }).$resources[0] = { ...(f.Items as { $resources: Row[] }).$resources[0], Active: false };
    await run(f);
    const r = await run(exportFile(), { allowDifferences: false, allowRefusals: false });
    const fields = r.differences.purchaseOrders.flatMap((x) => x.differences.map((d) => d.field));
    expect(fields.length).toBeGreaterThan(0);
    expect([...new Set(fields)]).toEqual(['lines[0].item_id']);
  });
});

describe('B5-E1: a deleted supplier carrying the Sage reference', () => {
  it('no PO is booked to it; the live supplier of the same name gets them', async () => {
    await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [s.suppliers.alpha]);
    const live = String((await pool.query(`INSERT INTO suppliers (company_id, name) VALUES ($1, 'Alpha Optics (Pty) Ltd') RETURNING id`, [s.companyId])).rows[0].id);
    expect((await run()).status).toBe('completed');
    const toDeleted = (await pool.query('SELECT po_number FROM purchase_orders WHERE company_id = $1 AND supplier_id = $2', [s.companyId, s.suppliers.alpha])).rows;
    const toLive = (await pool.query('SELECT po_number FROM purchase_orders WHERE company_id = $1 AND supplier_id = $2', [s.companyId, live])).rows;
    expect(toDeleted).toEqual([]);
    expect(toLive.length).toBeGreaterThan(0);
  });
});

describe('B5-G: a pool of one connection', () => {
  it('is refused with a clear error, not hung', async () => {
    const one = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const outcome = await Promise.race([
        run(exportFile(), { live: false }, one).then((r) => `settled: ${r.status}`, (e: Error) => `error: ${e.message}`),
        new Promise<string>((r) => setTimeout(() => r('HUNG'), 15_000)),
      ]);
      expect(outcome).toMatch(/^error: .*at least 2 connections/);
    } finally { await one.end(); }
  }, 60_000);
});
