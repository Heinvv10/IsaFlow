/**
 * Round-27 breaker B27-3 / review R27-3 on a real database, through the CLI. Run 0 imports the export; then a "user" session (a pg client
 * named like a web request) holds FIB-0001's row, idle in its transaction; run 1 changes FIB-0001's price, so its dry run waits on that
 * row until its lock_timeout (10 s) and the run refuses its start (exit 2):
 *   - hd1: the holder is named with its pid, application, state and transaction age, and left to whoever owns it: no pg_terminate_backend,
 *     no "the server ends it" (idle_in_transaction_session_timeout is 0 here, the PostgreSQL default);
 *   - hd3: a second user session waits on the same row ahead of the run: the run names the ROOT holder, never the waiter;
 *   - the CLI's own sessions carry application_name isaflow-sage-migration (what tells its own sessions apart).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { cleanupSageWorld, exportFile, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
const children = new Set<ChildProcess>();
const users: Client[] = [];
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r24-')); }, 120_000);
afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children.clear();
  for (const u of users.splice(0)) await u.end().catch(() => undefined);
  rmSync(d, { recursive: true, force: true });
  await cleanupSageWorld(pool, s);
  await cleanupWorld(pool, s.w);
}, 120_000);

const cli = (file: string, ms = 120_000): Promise<{ code: number | null; err: string }> => {
  const child = spawn('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', file,
    '--live', '--expect-items', '20', '--expect-pos', '10', '--allow-differences'], { env: { ...process.env, DATABASE_SSL: 'disable' } });
  children.add(child);
  let err = '';
  child.stderr!.on('data', (b) => { err += String(b); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
};
/** A "user" session, named like a web request. */
const user = async (app: string): Promise<Client> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: app });
  await c.connect();
  users.push(c);
  return c;
};
const LOCK = `SELECT pg_backend_pid() AS pid FROM items WHERE company_id = $1 AND code = 'FIB-0001' FOR UPDATE`;
/** The export with FIB-0001's price changed: run 1's dry run updates that row. */
const priceChanged = (): string => {
  const file = exportFile() as { Items: { $resources: Array<Record<string, unknown>> } };
  const fib = file.Items.$resources.find((r) => r.Code === 'FIB-0001')!;
  Object.assign(fib, { PriceExclusive: 108.5, PriceInclusive: 124.775 });
  const path = join(d, 'export-price1.json');
  writeFileSync(path, JSON.stringify(file));
  return path;
};
/** Waits until a migration session of this database waits on a lock, and returns its application_name. */
async function migrationWaiting(ms = 15_000): Promise<string | null> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) {
    const r = await pool.query(`SELECT application_name FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND application_name = 'isaflow-sage-migration'`);
    if (r.rows.length > 0) return r.rows[0].application_name as string;
  }
  return null;
}

describe('B27-3 / R27-3: who holds the row, and what the person is told', () => {
  it('hd1: a user idle in transaction: named with app, state and age; never offered for ending; the server never said to end it', async () => {
    expect((await cli('tests/fixtures/sage-export/sage-export.json')).code).toBe(0);
    const file = priceChanged();
    const holder = await user('IsaFlow web: invoice edit (qa@client)');
    await holder.query('BEGIN');
    const pid = (await holder.query(LOCK, [s.companyId])).rows[0].pid as number;
    const run = cli(file);
    expect(await migrationWaiting(), "the CLI's own session, by its application_name").toBe('isaflow-sage-migration');
    const r = await run;
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(new RegExp(`the dry run stopped at item batch 1 \\(.*\\): a lock it needs is held by another session and the wait timed out .*held by backend pid ${pid}, idle in transaction, application IsaFlow web: invoice edit \\(qa@client\\), in a transaction for \\d+ s: another session's open transaction; check with whoever owns it before ending it\\); then re-run; the live run was not started`));
    expect(r.err).not.toMatch(/pg_terminate_backend|server ends it|wait for the server/);
    await holder.query('ROLLBACK');
  }, 240_000);

  it('hd3: a second user waits on the row ahead of the run: the ROOT holder is named, never the waiter', async () => {
    expect((await cli('tests/fixtures/sage-export/sage-export.json')).code).toBe(0);
    const file = priceChanged();
    const a = await user('IsaFlow web: invoice edit (qa@client)');
    await a.query('BEGIN');
    const pidA = (await a.query(LOCK, [s.companyId])).rows[0].pid as number;
    const b = await user('IsaFlow web: stock count (sam@client)');
    const pidB = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await b.query('BEGIN');
    const bWaits = b.query(LOCK, [s.companyId]).catch((e: unknown) => e);
    for (let i = 0; i < 50 && (await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pidB])).rows[0].n === 0; i++) await new Promise((res) => setTimeout(res, 100));
    const r = await cli(file);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toContain(`held by backend pid ${pidA}, idle in transaction, application IsaFlow web: invoice edit (qa@client)`);
    expect(r.err).not.toContain(`backend pid ${pidB}`);
    await a.query('ROLLBACK');
    await bWaits;
    await b.query('ROLLBACK');
  }, 240_000);
});
