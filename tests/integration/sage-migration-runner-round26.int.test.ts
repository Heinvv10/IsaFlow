/**
 * R30-1 / R30-6 on a real database, through the CLI: the REAL runner, its real sessions and the CLI's own crash handler together. A
 * preload (helpers/sageCrashPreload.ts) raises an uncaught error while the 2nd live COMMIT (category batch 2) is in flight:
 *   - the run ends at once: no batch after the one in flight (books = the report's committed, 0 items), which settles and is said as such;
 *   - the books, the report and the console agree; exit 4.
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

const cli = (file: string, ms = 120_000, preload?: string): Promise<{ code: number | null; err: string }> => {
  const child = spawn('bun', ['--no-env-file', ...(preload ? ['--preload', preload] : []), 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', file,
    '--live', '--expect-items', '20', '--expect-pos', '10', '--allow-differences', '--report', join(d, 'r.json')], { env: { ...process.env, DATABASE_SSL: 'disable', SAGE_CRASH_AT_COMMIT: '2' } });
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
    expect(r.code, r.err).toBe(4);
    const books = (await pool.query(`SELECT (SELECT count(*)::int FROM item_categories WHERE company_id = $1) AS cats, (SELECT count(*)::int FROM items WHERE company_id = $1) AS items`, [s.companyId])).rows[0];
    const report = JSON.parse(readFileSync(join(d, 'r.json'), 'utf8'));
    expect(report).toMatchObject({ status: 'stopped', liveStarted: true });
    expect(books).toEqual({ cats: report.committed.length, items: 0 }); // books = report, and no batch after the end
    // The batch in flight at the crash (the 2nd COMMIT's, or the next one if it was already sent): listed unconfirmed when the run ended,
    // then as it settled; it is the last one: nothing after it.
    const flying = /commit unconfirmed: category batch (\d+) /.exec(r.err)?.[1];
    expect(flying, r.err).toBeDefined();
    expect(r.err).toMatch(new RegExp(`the batch in flight when the run ended, category batch ${flying} \\(.*\\), then committed; no batch followed it: the report says so`));
    expect(report.committed.map((b: { n: number }) => b.n)).toEqual(Array.from({ length: Number(flying) }, (_, k) => k + 1));
    expect(report.commitUnconfirmed).toEqual([]);
    expect(r.err).toMatch(/sage migration stopped: an uncaught error ended the run: injected crash at COMMIT 2/);
    expect(r.err).not.toMatch(new RegExp(`category batch ${Number(flying) + 1} |SUMMARY|: completed`));
  }, 240_000);
});
