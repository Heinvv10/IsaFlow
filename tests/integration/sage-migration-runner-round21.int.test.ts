/**
 * Round-18 findings through the CLI on a real database, under the round-18 decision (one RunState fed by onProgress, one terminate path):
 *   - B18-1: a second SIGTERM after the categories committed ends the run at once: exit 4, the stop report lists the 4 committed batches;
 *   - B18-2: piped to `| head -n 1`, the run is not killed by EPIPE: a completed report and exit 0 (or a stop report and exit 4);
 *   - B18-3: one SIGTERM in a dry run (waiting on a lock) stops it: exit 2, nothing written;
 *   - B18-4: SIGHUP is handled like SIGTERM: exit 4, a stop report listing what was committed;
 *   - B18-5: a stop report that cannot be written (a 1 KB file-size limit) leaves the small fallback body, valid JSON;
 *   - an uncaught error after a COMMIT: exit 4, a stop report (terminate).
 * The run is held where the breaker held it: a test connection locks `items` ACCESS EXCLUSIVE once the live categories are in the books,
 * so the run waits in its check between the phases. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
let holder: PoolClient | null = null;
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r21-')); }, 120_000);
afterEach(async () => {
  if (holder) { await holder.query('ROLLBACK'); holder.release(); holder = null; }
  rmSync(d, { recursive: true, force: true });
  await cleanupSageWorld(pool, s);
  await cleanupWorld(pool, s.w);
}, 120_000);

const FIXTURE = 'tests/fixtures/sage-export/sage-export.json';
const live = ['--live', '--expect-items', '20', '--expect-pos', '10'];
const report = () => join(d, 'report.json');
const json = () => JSON.parse(readFileSync(report(), 'utf8'));
const args = (extra: string[]) => ['scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', FIXTURE, '--report', report(), ...extra];
const env = () => ({ ...process.env, DATABASE_SSL: 'disable' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => Promise<boolean>, ms = 90_000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(100)) if (await ok()) return;
  throw new Error(`timed out waiting for ${what}`);
}
/** Locks `items` ACCESS EXCLUSIVE from the test (released in afterEach): the run waits on its next read of it. */
async function holdItems(): Promise<void> {
  holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('LOCK TABLE items IN ACCESS EXCLUSIVE MODE');
}
/** A run spawned in the background (optionally under a shell prefix); resolves with its exit code and output. */
function runAsync(cmd: string, argv: string[]) {
  const p = spawn(cmd, argv, { env: env() });
  let [out, err] = ['', ''];
  p.stdout.on('data', (b) => { out += String(b); });
  p.stderr.on('data', (b) => { err += String(b); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((r) => p.on('close', (code) => r({ code, out, err })));
  return { pid: p.pid!, done };
}
const bun = (extra: string[]) => runAsync('bun', ['--no-env-file', ...args(extra)]);
/**
 * Starts a live run and holds it once its categories are in the books, as the breaker did: a server-side loop waits for the first live
 * category, then locks `items` in the same transaction, before any item batch can start. The run waits in its check between the phases.
 */
async function liveHeldAfterCategories(start = () => bun(live)) {
  holder = await pool.connect();
  await holder.query('BEGIN');
  const company = s.companyId.replace(/[^0-9a-f-]/g, '');
  const locked = holder.query(`DO $$ BEGIN WHILE (SELECT count(*) FROM item_categories WHERE company_id = '${company}') < 1 LOOP PERFORM pg_sleep(0.005); END LOOP; END $$`)
    .then(() => holder!.query('LOCK TABLE items IN ACCESS EXCLUSIVE MODE'));
  const run = start();
  await locked;
  // Counted on item_categories alone: booked() reads items, which the holder has locked.
  await until('the 4 live categories', async () => (await pool.query('SELECT count(*)::int AS n FROM item_categories WHERE company_id = $1', [s.companyId])).rows[0].n === 4);
  await wait(1000);
  return run;
}
const listed = (r: { [k: string]: Array<{ entity: string; n: number }> }, k: string) => r[k]!.map((b) => `${b.entity} ${b.n}`);
const FOUR = ['category 1', 'category 2', 'category 3', 'category 4'];

describe('B18-1: a second signal after the categories committed', () => {
  it('exit 4; the stop report lists the 4 committed category batches (liveStarted true)', async () => {
    const run = await liveHeldAfterCategories();
    process.kill(run.pid, 'SIGTERM');
    await wait(500);
    process.kill(run.pid, 'SIGTERM');
    const r = await run.done;
    expect(r.code, r.err).toBe(4);
    const rep = json();
    expect(rep).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/stopped at once by a second signal \(SIGTERM\)/) });
    expect(listed(rep, 'committed')).toEqual(FOUR);
    await holder!.query('ROLLBACK'); holder!.release(); holder = null;
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 180_000);
});

describe('B18-4: SIGHUP', () => {
  it('is handled like SIGTERM: exit 4, a stop report listing the committed batches', async () => {
    const run = await liveHeldAfterCategories();
    process.kill(run.pid, 'SIGHUP');
    await wait(500);
    await holder!.query('ROLLBACK'); holder!.release(); holder = null;
    const r = await run.done;
    expect(r.code, r.err).toBe(4);
    expect(r.err).toMatch(/SIGHUP: the live run stops before its next batch/);
    const rep = json();
    expect(rep).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/stopped by SIGHUP/) });
    expect(listed(rep, 'committed')).toEqual(FOUR);
  }, 180_000);
});

describe('B18-5: a stop report that cannot be written', () => {
  it('leaves the small fallback body (valid JSON), exit 4', async () => {
    const shell = () => runAsync('bash', ['-c', `trap '' XFSZ; ulimit -f 1; exec bun --no-env-file "$@"`, 'run', ...args(live)]);
    const run = await liveHeldAfterCategories(shell);
    process.kill(run.pid, 'SIGTERM'); // bash exec'd bun: the same pid
    await wait(500);
    await holder!.query('ROLLBACK'); holder!.release(); holder = null;
    const r = await run.done;
    expect(r.code, r.err).toBe(4);
    expect(r.err).toMatch(/could not be written: EFBIG/);
    expect(json()).toMatchObject({ status: 'stop_report_not_written', exitCode: 4 });
  }, 180_000);
});

describe('B18-3: one SIGTERM in a dry run', () => {
  it('stops it: exit 2, a stop report liveStarted false, nothing written', async () => {
    await holdItems();
    const run = bun([]);
    await until('the run waiting on the items lock', async () => (await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND pid <> pg_backend_pid()`)).rows[0].n > 0);
    process.kill(run.pid, 'SIGTERM');
    await wait(500);
    await holder!.query('ROLLBACK'); holder!.release(); holder = null;
    const r = await run.done;
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(/SIGTERM: the run stops before its next batch; nothing is written to the books/);
    expect(json()).toMatchObject({ status: 'stopped', liveStarted: false, committed: [] });
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 0, items: 0 });
  }, 180_000);
});

describe('B18-2: a live run piped to | head -n 1', () => {
  it('is not killed by EPIPE: a completed report and exit 0, or a stop report and exit 4', () => {
    const r = spawnSync('bash', ['-c', 'bun --no-env-file "$@" | head -n 1 > /dev/null; exit "${PIPESTATUS[0]}"', 'run', ...args(live)], { encoding: 'utf8', timeout: 170_000, env: env() });
    const rep = json();
    expect([0, 4], r.stderr).toContain(r.status);
    expect(rep.status, r.stderr).toBe(r.status === 0 ? 'completed' : 'stopped');
    expect(r.stderr).not.toMatch(/EPIPE: broken pipe, write\n\s+fd:/); // not the uncaught crash
  }, 180_000);
});

describe('an uncaught error after a COMMIT', () => {
  it('ends the run through terminate: exit 4, a stop report with the first category batch listed (the next one, in flight, as commit unconfirmed)', async () => {
    const r = spawnSync('bun', ['--no-env-file', '--preload', join(process.cwd(), 'tests/integration/helpers/sageCrashAtCommitPreload.ts'), ...args(live)],
      { encoding: 'utf8', timeout: 170_000, env: { ...env(), SAGE_CRASH_AT_COMMIT: '1' } });
    expect(r.status, r.stderr).toBe(4);
    expect(r.stderr).toMatch(/an uncaught error ended the run: injected crash after a COMMIT/);
    const rep = json();
    expect(rep).toMatchObject({ status: 'stopped', liveStarted: true });
    // The timer fires on a later turn: category 1 is committed; the next batch may already be in flight (listed commit unconfirmed).
    expect(listed(rep, 'committed')[0]).toBe('category 1');
    expect(listed(rep, 'commitUnconfirmed').length).toBeLessThanOrEqual(1);
    const known = [...listed(rep, 'committed'), ...listed(rep, 'commitUnconfirmed')];
    expect(known).toEqual(FOUR.slice(0, known.length));
    expect(known.length).toBeLessThanOrEqual(2);
  }, 180_000);
});
