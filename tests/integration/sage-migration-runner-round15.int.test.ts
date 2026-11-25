/**
 * Round-12 breaker findings on a real database (b12-a probes B12-A1, A2, A3, A6 ported). The structural rule: what the summary and the
 * stop say a batch did comes from that batch's LIVE tool answer; "nothing written" only when the request rolled back or the registry said
 * it served a stored answer; the books check after the COMMIT can only add "then changed in the books since".
 *   - B12-1: an unconfirmed COMMIT that LANDED names, from the live answer, a row edited after the dry run;
 *   - B12-2 / B12-3: a committed batch with another row soft-deleted after it is "committed", its overwrite named, never "replayed,
 *     nothing written" (nor --run-tag, which would re-import a row a person deleted);
 *   - B12-4: a tool SUCCESS with a non-JSON answer rolls its request back, so "failed, nothing written" is true;
 *   - note: a stopped CLI run overwrites the --report file with a stop report, so an earlier run's report is not left there.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, landedCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import type { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { mcpRegistry } from '@/lib/mcp/toolIndex';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Row = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });
const run = (over: Row = {}, p: Pool = pool) => runSageMigration(p, parsedExport(exportFile()), opts(over));
const stopped = (p: Promise<unknown>) => p.then(() => { throw new Error('the run did not stop'); }, (e: unknown) => e as MigrationStopped);
const desc = async (ref: string) => (await pool.query(`SELECT description FROM items WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref])).rows[0]?.description;
const edit = (ref: string) => pool.query(`UPDATE items SET description = 'edited', updated_at = now() WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);
const softDelete = (ref: string) => pool.query(`UPDATE items SET deleted_at = now(), updated_at = now() WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);

describe('B12-1 (B12-A1): an unconfirmed COMMIT that landed, FIB-0016 edited after the dry run', () => {
  it('the stop names FIB-0016 under "may have been updated", from the live answer (the dry run never saw the edit)', async () => {
    expect((await run()).status).toBe('completed');
    // Re-run commits: 1-4 categories, 5 item batch 1, 6 item batch 2. The edit lands after category commit 1: after the dry run.
    const hooked = afterCommitOf(pool, 'upsert_item_category', { after: async () => { await edit('50016'); } });
    const err = await stopped(run({ itemBatchSize: 10 }, landedCommitPool(hooked, [6])));
    expect(exitCodeForError(err)).toBe(4);
    expect(await desc('50016')).not.toBe('edited'); // the COMMIT landed: the edit was overwritten
    expect(stopMessage(err)).toMatch(/commit unconfirmed: item batch 2[^\n]*\n {2}may have been updated to Sage's values \(check the books\): item FIB-0016 \(description\)/);
  });
});

describe('B12-2 (B12-A2): a committed item batch, then another item of it soft-deleted (no stop)', () => {
  it('FIB-0002 "was updated" (another row changed); FIB-0003 is the row named; nothing says replayed or nothing written', async () => {
    expect((await run()).status).toBe('completed');
    await edit('50002');
    const r = await run({}, afterCommitOf(pool, 'bulk_upsert_items', { after: async () => { await softDelete('50003'); } }));
    const lines = summaryLines(r);
    expect(r.status).toBe('failed');
    expect(r.live!.items.batches[0]).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['FIB-0003'] });
    expect(r.live!.items.batches[0]!.replayed).toBeUndefined();
    expect(lines.find((l) => /item FIB-0002/.test(l))).toBe("DIFFERS: item FIB-0002 was updated to Sage's values (another row of its batch changed since: check): description");
    expect(lines.join('\n')).not.toMatch(/writing nothing|replayed|--run-tag/);
    expect(await desc('50002')).not.toBe('edited');
  });
});

describe('B12-3 (B12-A3): the same, and the run then stops (item batch 2 COMMIT unconfirmed)', () => {
  it('the stop says item batch 1 committed, names FIB-0002 as overwritten, and never "nothing written" or --run-tag for it', async () => {
    expect((await run()).status).toBe('completed');
    await edit('50002');
    const hooked = afterCommitOf(pool, 'bulk_upsert_items', { after: async () => { await softDelete('50003'); } });
    const err = await stopped(run({ itemBatchSize: 10 }, landedCommitPool(hooked, [6])));
    const m = stopMessage(err);
    expect(m).toMatch(/committed: item batch 1 \([^)]*\) \(then changed or removed in the books by another writer: FIB-0003: check\)/);
    expect(m).toMatch(/\n {2}was updated to Sage's values \(another row of its batch changed since: check\): item FIB-0002 \(description\)/);
    expect(m).not.toMatch(/replayed|--run-tag|nothing written: item batch 1/);
    expect(await desc('50002')).not.toBe('edited');
  });
});

describe('B12-4 (B12-A6): a live item batch whose tool succeeds with a non-JSON answer', () => {
  it('its request rolls back, so "failed, nothing written" is true: none of its items are in the books', async () => {
    const real = mcpRegistry.call.bind(mcpRegistry);
    vi.spyOn(mcpRegistry, 'call').mockImplementation(async (name, args, ctx) => {
      const r = await real(name, args, ctx);
      const key = String(args.idempotency_key ?? '');
      if (name === 'bulk_upsert_items' && key.startsWith('sage-mig-item-0001-') && !key.endsWith('-dry') && r.isError !== true) return { content: [{ type: 'text', text: '<html>502 Bad Gateway</html>' }] };
      return r;
    });
    const r = await run({ itemBatchSize: 10 });
    expect(r.status).toBe('failed');
    expect(r.live!.items.batches.map((b) => b.status)).toEqual(['failed', 'ok']);
    expect(r.live!.items.batches[0]!.error).toMatch(/not JSON/);
    const refs = (await pool.query(`SELECT external_ref FROM items WHERE company_id = $1 ORDER BY external_ref::INT`, [s.companyId])).rows.map((x) => Number(x.external_ref));
    expect(refs).toEqual([50011, 50012, 50013, 50014, 50015, 50016, 50017, 50018, 50019, 50020]); // batch 2 only: batch 1 rolled back
    expect(exitCodeFor(r, true, true)).toBe(1);
  });
});

describe('B12-A4 / A5 regress: an unconfirmed COMMIT that landed on a category or PO batch', () => {
  it('a first run: PO batch 2 of 3 lands unanswered: exit 4, PO batch 1 committed, 2 unconfirmed, 3 not sent; the re-run books 10', async () => {
    const err = await stopped(run({ poBatchSize: 4 }, landedCommitPool(pool, [7]))); // 1-4 categories, 5 items, 6 PO 1, 7 PO 2
    const m = stopMessage(err);
    expect(m).toMatch(/committed: purchase_order batch 1 [^\n]*\ncommit unconfirmed: purchase_order batch 2/);
    expect(m).not.toMatch(/purchase_order batch 3/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 8 });
    expect((await run({ poBatchSize: 4 })).status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ pos: 10 });
  });
});

describe('note (round 12): a stopped CLI run and the --report file of an earlier run', () => {
  it('the file is replaced by a stop report (status stopped, the batches listed); the exit code is the stop\'s 4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sage-stop-report-'));
    try {
      const report = join(dir, 'report.json');
      writeFileSync(report, JSON.stringify({ status: 'completed', note: 'an earlier run' }));
      const r = spawnSync('bun', ['--no-env-file', '--preload', join(process.cwd(), 'tests/integration/helpers/sageFailCommitPreload.ts'), 'scripts/sage-migration/run.ts',
        '--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json', '--live', '--expect-items', '20', '--expect-pos', '10', '--report', report],
      { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', SAGE_FAIL_COMMIT: '5' } }); // 4 categories, then the item batch
      expect(r.status).toBe(4);
      const json = JSON.parse(readFileSync(report, 'utf8'));
      expect(json).toMatchObject({ status: 'stopped', liveStarted: true });
      expect(json.message).toMatch(/commit unconfirmed: item batch 1 \(/);
      expect(json.committed.map((b: { entity: string; n: number }) => `${b.entity} ${b.n}`)).toEqual(['category 1', 'category 2', 'category 3', 'category 4', 'item 1']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
