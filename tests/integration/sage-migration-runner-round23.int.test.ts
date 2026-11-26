/**
 * Round-22 breaker (B22-1, B22-2) under the structural rule: a connection lost BEFORE a live batch's COMMIT is sent means the COMMIT was
 * never sent (pg marks the client not queryable), so the batch FAILED and nothing of it was written, whatever the tool answered: never
 * "commit unconfirmed", never the dry run's "may have been updated". The run still stops, exit 4 (the live phase had started).
 * Through sageHoldProxy (a TCP proxy, no app code patched): the server's answer to the last query before the COMMIT is held; the backend,
 * idle in transaction, is killed in the hold; its FATAL reaches the client in the same chunk as that answer.
 *   - refgap: a GENUINE refusal (a trigger refuses the live update of FIB-0001; the dry run's passed and answered "updated");
 *   - okgap: the tool answered ok.
 * R23-5 / B23-1: the dry run's ROLLBACK blackholed (never answers; the backend keeps its writes and number lock): a refused start (exit 2).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { holdProxy, type HoldProxy } from './helpers/sageHoldProxy';
import { booked, cleanupSageWorld, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
let proxy: HoldProxy | null = null;
/** Every CLI this file starts: killed in afterEach if still running (R24-1: CI must never hang on, or leave behind, a child). */
const children = new Set<ChildProcess>();
const tag = () => s.companyId.replace(/[^0-9a-f]/g, '');
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r23-')); }, 120_000);
afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children.clear();
  if (proxy) { await proxy.close(); proxy = null; }
  await pool.query(`DROP TRIGGER IF EXISTS b22r_${tag()} ON items; DROP SEQUENCE IF EXISTS public.b22q_${tag()}`);
  rmSync(d, { recursive: true, force: true });
  await cleanupSageWorld(pool, s);
  await cleanupWorld(pool, s.w);
}, 120_000);

const url = (port: number) => { const u = new URL(process.env.DATABASE_URL!); u.port = String(port); return u.toString(); };
const args = (report: string, extra: string[] = []) => ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId,
  '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10', ...extra];
const env = (databaseUrl = process.env.DATABASE_URL!) => ({ ...process.env, DATABASE_SSL: 'disable', DATABASE_URL: databaseUrl });

/**
 * Starts the CLI (spawn, never spawnSync: the proxy runs in this process and must keep serving): bounded by `ms` (then SIGKILL, code
 * null), rejected on a spawn 'error', tracked for afterEach (R24-1). Resolves with the exit code and stderr.
 */
function startCli(argv: string[], databaseUrl: string, ms = 120_000): { child: ChildProcess; done: Promise<{ code: number | null; err: string }> } {
  const child = spawn('bun', argv, { env: env(databaseUrl) });
  children.add(child);
  let err = '';
  child.stderr!.on('data', (b) => { err += String(b); });
  const done = new Promise<{ code: number | null; err: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
  return { child, done };
}
/** No backend of this database is left idle in transaction (R24-2: a held dry transaction really ended), within `ms`. */
async function noneIdleInTransaction(ms = 15_000): Promise<number> {
  let n = -1;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) {
    n = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'
      AND backend_type = 'client backend' AND pid <> pg_backend_pid()`)).rows[0].n;
    if (n === 0) break;
  }
  return n;
}

/** Runs the CLI through the proxy, kills the backend idle in transaction once the hold starts; resolves with the exit code and stderr. */
async function runThroughHold(report: string, extra: string[]): Promise<{ code: number | null; err: string }> {
  const { done: finished } = startCli(args(report, extra), url(proxy!.port));
  const done = finished.then((r) => r.code);
  let err = '';
  void finished.then((r) => { err = r.err; });
  await proxy!.held;
  await new Promise((r) => setTimeout(r, 300));
  const victims = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'
    AND backend_type = 'client backend' AND pid <> pg_backend_pid()`)).rows.map((r) => r.pid);
  expect(victims, 'the held request, idle in transaction').toHaveLength(1);
  await pool.query('SELECT pg_terminate_backend($1)', [victims[0]]);
  const code = await done;
  err = (await finished).err;
  return { code, err };
}
const upstreamPort = () => Number(new URL(process.env.DATABASE_URL!).port || 5432);

describe('round 22: lost before the COMMIT was sent', () => {
  it('refgap: a genuine refusal, then the loss: FAILED, nothing written; never commit unconfirmed nor the dry run\'s answer', async () => {
    expect(spawnSync('bun', args(join(d, 'first.json')), { encoding: 'utf8', timeout: 170_000, env: env() }).status).toBe(0);
    const company = s.companyId.replace(/[^0-9a-f-]/g, '');
    const price = (await pool.query(`UPDATE items SET selling_price_excl = selling_price_excl + 1 WHERE company_id = $1 AND code = 'FIB-0001' RETURNING selling_price_excl::TEXT AS p`, [s.companyId])).rows[0].p;
    await pool.query(`CREATE SEQUENCE public.b22q_${tag()}; GRANT USAGE ON SEQUENCE public.b22q_${tag()} TO PUBLIC;
      CREATE OR REPLACE FUNCTION public.b22q_${tag()}_refuse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF nextval('public.b22q_${tag()}') > 1 THEN RAISE EXCEPTION 'b22: the books refuse this item'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER b22r_${tag()} BEFORE UPDATE ON items FOR EACH ROW WHEN (NEW.company_id = '${company}' AND NEW.code = 'FIB-0001') EXECUTE FUNCTION public.b22q_${tag()}_refuse();`);
    proxy = await holdProxy({ upstreamPort: upstreamPort(), p1: 'ROLLBACK TO SAVEPOINT mcp_bulk_upsert_items', p2: 'INSERT INTO mcp_tool_calls' });
    const report = join(d, 'report.json');
    const r = await runThroughHold(report, ['--allow-differences']);
    expect(r.code, r.err).toBe(4);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.commitUnconfirmed).toEqual([]);
    expect(rep.failed).toEqual([expect.objectContaining({ entity: 'item', n: 1, status: 'failed', error: expect.stringMatching(/^the connection was lost before its COMMIT was sent \(.*\); nothing of it was written$/) })]);
    expect(r.err).toMatch(/failed, nothing written: item batch 1 .*the connection was lost before its COMMIT was sent/);
    expect(r.err).not.toMatch(/dry run's answer|may have been updated|commit unconfirmed/);
    expect((await pool.query(`SELECT selling_price_excl::TEXT AS p FROM items WHERE company_id = $1 AND code = 'FIB-0001'`, [s.companyId])).rows[0].p).toBe(price);
  }, 400_000);

  it('okgap: the tool answered ok, then the loss: FAILED, nothing written (items 0), never commit unconfirmed', async () => {
    proxy = await holdProxy({ upstreamPort: upstreamPort(), p1: 'RELEASE SAVEPOINT items_apply', p2: 'RELEASE SAVEPOINT mcp_bulk_upsert_items', nth: 2 });
    const report = join(d, 'report.json');
    const r = await runThroughHold(report, []);
    expect(r.code, r.err).toBe(4);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.commitUnconfirmed).toEqual([]);
    expect(rep.failed).toEqual([expect.objectContaining({ entity: 'item', n: 1, error: expect.stringMatching(/before its COMMIT was sent .*nothing of it was written/) })]);
    expect(r.err).not.toMatch(/it may still land|commit unconfirmed/);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 400_000);
});

describe('R23-5 / B23-1: the dry run\'s ROLLBACK never answers (blackholed: the backend stays idle in transaction, holding its writes)', () => {
  const blackhole = () => holdProxy({ upstreamPort: upstreamPort(), p1: 'RELEASE SAVEPOINT mcp_bulk_upsert_items', p2: 'ROLLBACK\u0000', blackhole: true });
  it('a refused start: exit 2, "the dry run\'s ROLLBACK was not confirmed (...)", its backend pid said; the live run is not started', async () => {
    proxy = await blackhole();
    const report = join(d, 'report.json');
    const r = await startCli(args(report), url(proxy.port)).done;
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(/the dry run's ROLLBACK was not confirmed \(ROLLBACK did not answer within \d+ms\); its writes may still be held \(backend pid \d+: wait for the server to end it, or SELECT pg_terminate_backend\(\d+\)\), so the live run was not started/);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false, committed: [] });
    await proxy.close(); // the server side ends: the dry transaction rolls back
    proxy = null;
    expect(await noneIdleInTransaction(), 'the held dry transaction ended').toBe(0); // R24-2: not only "nothing visible"
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 0, items: 0 });
  }, 180_000);

  it('B24-2: a re-run behind that held dry transaction says so at once (exit 2, the holder\'s pid), never a silent wait', async () => {
    proxy = await blackhole();
    const run1 = await startCli(args(join(d, 'run1.json')), url(proxy.port)).done;
    expect(run1.code).toBe(2);
    const zombie = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'
      AND backend_type = 'client backend' AND pid <> pg_backend_pid()`)).rows.map((r) => r.pid);
    expect(zombie, 'run 1\'s dry transaction, still open').toHaveLength(1);
    expect(run1.err).toContain(`its writes may still be held (backend pid ${zombie[0]}:`); // the pid it names is that backend's
    const t0 = Date.now();
    const r = await startCli(args(join(d, 'run2.json')), process.env.DATABASE_URL!, 60_000).done; // a plain re-run, no proxy
    expect(r.code, r.err).toBe(2);
    expect(Date.now() - t0).toBeLessThan(45_000);
    expect(r.err).toContain(`another session holds this batch's lock (likely a previous run's dry transaction, backend pid ${zombie[0]}: wait for the server to end it, or SELECT pg_terminate_backend(${zombie[0]})); wait or terminate it, then re-run`);
    await proxy.close();
    proxy = null;
    expect(await noneIdleInTransaction()).toBe(0);
  }, 240_000);
});
