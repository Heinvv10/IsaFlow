/**
 * R30-1 / R30-6 on a real database, through the CLI: the REAL runner, its real sessions and the CLI's own crash handler together. A
 * preload (helpers/sageCrashPreload.ts) raises an uncaught error while the 2nd live COMMIT (category batch 2) is in flight (its answer
 * held until the crash has fired, so the order is the same on every machine):
 *   - the run ends at once: no batch after the one in flight (books = the report's committed, 0 items), which settles and is said as such;
 *   - the books, the report and the console agree; exit 4.
 * And the order GitHub hit with the old preload (the COMMIT answered within the crash timer's millisecond): the crash between batch 2's
 * recorded COMMIT and batch 3, nothing in flight: batches 1-2 committed, no batch named in flight, nothing after; exit 4.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { cleanupSageWorld, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
const children = new Set<ChildProcess>();
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r26-')); }, 120_000);
afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children.clear();
  rmSync(d, { recursive: true, force: true });
  await cleanupSageWorld(pool, s);
  await cleanupWorld(pool, s.w);
}, 120_000);

const cli = (file: string, ms = 120_000, preload?: string, when = 'in-flight'): Promise<{ code: number | null; err: string }> => {
  const child = spawn('bun', ['--no-env-file', ...(preload ? ['--preload', preload] : []), 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', file,
    '--live', '--expect-items', '20', '--expect-pos', '10', '--allow-differences', '--report', join(d, 'r.json')], { env: { ...process.env, DATABASE_SSL: 'disable', SAGE_CRASH_AT_COMMIT: '2', SAGE_CRASH_WHEN: when } });
  children.add(child);
  let err = '';
  child.stderr!.on('data', (b) => { err += String(b); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
};
describe('R30-1 / R30-6: an uncaught error while a live COMMIT is in flight', () => {
  it('no batch after it; the batch in flight settles and is said; books = report = console; exit 4', async () => {
    const r = await cli('tests/fixtures/sage-export/sage-export.json', 120_000, './tests/integration/helpers/sageCrashPreload.ts');
    expect(r.err, 'the preload\'s hold never fired (COMMIT 2 not seen as a promise-style query)').toContain('[sage-crash-preload] held COMMIT 2 until the crash');
    expect(r.code, r.err).toBe(4);
    const books = (await pool.query(`SELECT (SELECT count(*)::int FROM item_categories WHERE company_id = $1) AS cats, (SELECT count(*)::int FROM items WHERE company_id = $1) AS items`, [s.companyId])).rows[0];
    const report = JSON.parse(readFileSync(join(d, 'r.json'), 'utf8'));
    expect(report).toMatchObject({ status: 'stopped', liveStarted: true });
    expect(books).toEqual({ cats: report.committed.length, items: 0 }); // books = report, and no batch after the end
    // The batch in flight at the crash (the 2nd COMMIT's: its answer is held until the crash): listed unconfirmed when the run ended,
    // then as it settled; it is the last one: nothing after it.
    const flying = /commit unconfirmed: category batch (\d+) /.exec(r.err)?.[1];
    expect(flying, r.err).toBe('2');
    expect(r.err).toMatch(new RegExp(`the batch in flight when the run ended, category batch ${flying} \\(.*\\), then committed; no batch followed it: the report says so`));
    expect(report.committed.map((b: { n: number }) => b.n)).toEqual(Array.from({ length: Number(flying) }, (_, k) => k + 1));
    expect(report.commitUnconfirmed).toEqual([]);
    expect(r.err).toMatch(/sage migration stopped: an uncaught error ended the run: injected crash at COMMIT 2/);
    expect(r.err).not.toMatch(new RegExp(`category batch ${Number(flying) + 1} |SUMMARY|: completed`));
  }, 240_000);
  it('the crash between two batches (batch 2 committed and recorded, batch 3 not sent): nothing named in flight; books = report = console', async () => {
    const r = await cli('tests/fixtures/sage-export/sage-export.json', 120_000, './tests/integration/helpers/sageCrashPreload.ts', 'between');
    expect(r.err, 'the preload\'s hold never fired: is the run lock check still the literal \'SELECT 1\' (sageRunLock.ts check())?').toContain('[sage-crash-preload] held the run lock check after COMMIT 2 until the crash');
    expect(r.code, r.err).toBe(4);
    const books = (await pool.query(`SELECT (SELECT count(*)::int FROM item_categories WHERE company_id = $1) AS cats, (SELECT count(*)::int FROM items WHERE company_id = $1) AS items`, [s.companyId])).rows[0];
    const report = JSON.parse(readFileSync(join(d, 'r.json'), 'utf8'));
    expect(report).toMatchObject({ status: 'stopped', liveStarted: true, commitUnconfirmed: [] });
    expect(report.committed.map((b: { n: number }) => b.n)).toEqual([1, 2]);
    expect(books).toEqual({ cats: 2, items: 0 });
    expect(r.err).toMatch(/sage migration stopped: an uncaught error ended the run: injected crash at COMMIT 2/);
    expect(r.err).toMatch(/committed: category batch 1 .*\ncommitted: category batch 2 /);
    expect(r.err).not.toMatch(/commit unconfirmed|the batch in flight when the run ended|category batch 3 |SUMMARY|: completed/);
  }, 240_000);
});
