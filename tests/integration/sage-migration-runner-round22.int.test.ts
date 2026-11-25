/**
 * Round-19 breaker B19-1 through the CLI on a real database: the backend of a live batch is killed while the batch waits inside its request
 * (a test connection holds `items` in SHARE mode right after the first live category, so the item batch's inserts wait; then
 * pg_terminate_backend on the waiting backend). With the client's 'error' listened to in withToolSession, the run takes its designed
 * path: exit 4 (not "an uncaught error ended the run"), the committed categories checked against the books, and (round-22 rule) the
 * item batch FAILED, nothing written: its connection was lost before its COMMIT was sent, so no COMMIT was; never "the tool refused".
 * R20-2 / R20-1: the backend killed DURING the item batch's COMMIT (a deferred trigger of this company's FIB-0001 sleeps at COMMIT): the
 * FATAL rejects the COMMIT before any client error, still read as a lost connection, and the batch keeps its OK live answer.
 * B20-1: the backend of the DRY RUN killed while its item insert waits: a refused start (exit 2), "the connection ... was lost ...
 * nothing of it was written", never a batch "failed" in a dry_run_failed report.
 * B21-1: a live batch the tool REFUSES (a trigger refuses the live update of FIB-0001, the dry run's passes), its COMMIT then killed: the
 * refusal is kept (toolRefused, "the tool refused this batch"), never the dry run's "may have been updated". B21-2: an 08006 raised by
 * the books' own SQL at the COMMIT, on a live connection: unconfirmed, never "the connection was lost".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
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
const release = async () => { if (holder) { await holder.query('ROLLBACK'); holder.release(); holder = null; } };
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r22-')); }, 120_000);
afterEach(async () => { await release(); rmSync(d, { recursive: true, force: true }); await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitingOnItems = `SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'items' AND NOT l.granted`;

describe('B19-1: a live batch whose connection is killed while it waits in its request', () => {
  it('exit 4 by the designed path: the categories committed, the item batch FAILED (lost before its COMMIT was sent), nothing of it written', async () => {
    const report = join(d, 'report.json');
    holder = await pool.connect();
    await holder.query('BEGIN');
    const company = s.companyId.replace(/[^0-9a-f-]/g, '');
    const locked = holder.query(`DO $$ BEGIN WHILE (SELECT count(*) FROM item_categories WHERE company_id = '${company}') < 1 LOOP PERFORM pg_sleep(0.005); END LOOP; END $$`)
      .then(() => holder!.query('LOCK TABLE items IN SHARE MODE'));
    const p = spawn('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
      '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10'], { env: { ...process.env, DATABASE_SSL: 'disable' } });
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); });
    const done = new Promise<number | null>((r) => p.on('close', r));
    await locked;
    let victims: number[] = [];
    for (const t0 = Date.now(); victims.length === 0 && Date.now() - t0 < 90_000; await wait(50)) victims = (await pool.query(waitingOnItems)).rows.map((r) => r.pid);
    expect(victims, 'a backend waiting on items').toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [victims[0]]);
    await release();
    const code = await done;
    expect(code, err).toBe(4);
    expect(err).not.toMatch(/an uncaught error ended the run/);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/^sage migration stopped: item batch 1 .* failed: the connection was lost before its COMMIT was sent \(.*\); nothing of it was written/) });
    expect(rep.message).not.toMatch(/stopped at once|tool refused|may still land/);
    expect(rep.committed.map((b: { entity: string; n: number }) => `${b.entity} ${b.n}`)).toEqual(['category 1', 'category 2', 'category 3', 'category 4']);
    expect(rep.commitUnconfirmed).toEqual([]);
    expect(rep.failed).toEqual([expect.objectContaining({ entity: 'item', n: 1, status: 'failed', error: expect.stringMatching(/^the connection was lost before its COMMIT was sent/) })]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 180_000);
});

describe('R20-2: a backend killed during the COMMIT itself', () => {
  const trigger = () => `sage_r22_${s.companyId.replace(/[^0-9a-f]/g, '')}`;
  afterEach(async () => { await pool.query(`DROP TRIGGER IF EXISTS ${trigger()} ON items`); }, 60_000);
  it('exit 4: the item batch commit unconfirmed as a lost connection, its live answer kept, nothing of it written', async () => {
    const company = s.companyId.replace(/[^0-9a-f-]/g, '');
    await pool.query(`CREATE OR REPLACE FUNCTION public.sage_r22_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN NULL; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger()} AFTER INSERT ON items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.company_id = '${company}' AND NEW.code = 'FIB-0001') EXECUTE FUNCTION public.sage_r22_slow_commit()`);
    const report = join(d, 'report.json');
    const p = spawn('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
      '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10'], { env: { ...process.env, DATABASE_SSL: 'disable' } });
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); });
    const done = new Promise<number | null>((r) => p.on('close', r));
    // The live item batch's COMMIT, sleeping in the trigger (the dry run's rolls back and never fires a deferred trigger).
    let victims: number[] = [];
    for (const t0 = Date.now(); victims.length === 0 && Date.now() - t0 < 120_000; await wait(50)) {
      victims = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE query = 'COMMIT' AND state = 'active' AND wait_event = 'PgSleep' AND datname = current_database()`)).rows.map((r) => r.pid);
    }
    expect(victims, 'a COMMIT in the trigger').toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [victims[0]]);
    const code = await done;
    expect(code, err).toBe(4);
    expect(err).not.toMatch(/an uncaught error ended the run/);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.message).toMatch(/the COMMIT of item batch 1 .* did not answer \(the connection was lost; its COMMIT was not confirmed/);
    expect(rep.commitUnconfirmed).toEqual([expect.objectContaining({ entity: 'item', n: 1, commitUnconfirmed: true, error: expect.stringMatching(/^the connection was lost/) })]);
    expect(rep.commitUnconfirmed[0].toolReported).toMatchObject({ written: true }); // R20-1: the live answer, not null (never the dry run's)
    expect(rep.commitUnconfirmed[0].toolRefused).toBeUndefined();
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 180_000);
});

describe('B20-1: the dry run\'s backend killed while it waits', () => {
  it('a refused start: exit 2, the lost connection said, nothing written, no batch blamed', async () => {
    const report = join(d, 'report.json');
    holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE items IN SHARE MODE'); // reads go on (the plan); the dry run's item insert waits
    const p = spawn('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
      '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10'], { env: { ...process.env, DATABASE_SSL: 'disable' } });
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); });
    const done = new Promise<number | null>((r) => p.on('close', r));
    let victims: number[] = [];
    for (const t0 = Date.now(); victims.length === 0 && Date.now() - t0 < 90_000; await wait(50)) victims = (await pool.query(waitingOnItems)).rows.map((r) => r.pid);
    expect(victims, 'the dry run waiting on items').toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [victims[0]]);
    await release();
    const code = await done;
    expect(code, err).toBe(2);
    expect(err).toMatch(/sage migration stopped: the connection to the database was lost \(.*\) in a request that writes nothing \(the dry run, the plan or a read of the books\): that request wrote nothing/);
    expect(err).not.toMatch(/FAILED item batch|an uncaught error/);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false, committed: [] });
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 0, items: 0 });
  }, 180_000);
});

describe('B21-1 / B21-2: a COMMIT that fails after the tool answered', () => {
  const tag = () => s.companyId.replace(/[^0-9a-f]/g, '');
  afterEach(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS b21r_${tag()} ON items; DROP TRIGGER IF EXISTS b21s_${tag()} ON mcp_tool_calls; DROP TRIGGER IF EXISTS b21f_${tag()} ON items; DROP SEQUENCE IF EXISTS public.b21q_${tag()}`);
  }, 60_000);
  const args = (report: string, extra: string[]) => ['--no-env-file', 'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId,
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10', ...extra];
  const env = () => ({ ...process.env, DATABASE_SSL: 'disable' });

  it('B21-1: a refused live batch whose COMMIT is killed keeps its refusal, never the dry run\'s answer; nothing written', async () => {
    expect(spawnSync('bun', args(join(d, 'first.json'), []), { encoding: 'utf8', timeout: 170_000, env: env() }).status).toBe(0);
    const company = s.companyId.replace(/[^0-9a-f-]/g, '');
    const price = (await pool.query(`UPDATE items SET selling_price_excl = selling_price_excl + 1 WHERE company_id = $1 AND code = 'FIB-0001' RETURNING selling_price_excl::TEXT AS p`, [s.companyId])).rows[0].p;
    await pool.query(`CREATE SEQUENCE public.b21q_${tag()}; GRANT USAGE ON SEQUENCE public.b21q_${tag()} TO PUBLIC;
      CREATE OR REPLACE FUNCTION public.b21q_${tag()}_refuse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF nextval('public.b21q_${tag()}') > 1 THEN RAISE EXCEPTION 'b21: the books refuse this item'; END IF; RETURN NEW; END $$;
      CREATE OR REPLACE FUNCTION public.sage_r22_slow_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM pg_sleep(30); RETURN NULL; END $$;
      CREATE TRIGGER b21r_${tag()} BEFORE UPDATE ON items FOR EACH ROW WHEN (NEW.company_id = '${company}' AND NEW.code = 'FIB-0001') EXECUTE FUNCTION public.b21q_${tag()}_refuse();
      CREATE CONSTRAINT TRIGGER b21s_${tag()} AFTER INSERT ON mcp_tool_calls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.company_id = '${company}' AND NEW.tool = 'bulk_upsert_items') EXECUTE FUNCTION public.sage_r22_slow_commit();`);
    const report = join(d, 'report.json');
    const p = spawn('bun', args(report, ['--allow-differences']), { env: env() });
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); });
    const done = new Promise<number | null>((r) => p.on('close', r));
    let victims: number[] = [];
    for (const t0 = Date.now(); victims.length === 0 && Date.now() - t0 < 120_000; await wait(50)) {
      victims = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE query = 'COMMIT' AND state = 'active' AND wait_event = 'PgSleep' AND datname = current_database()`)).rows.map((r) => r.pid);
    }
    expect(victims, 'the refused batch\'s COMMIT in the trigger').toHaveLength(1);
    await pool.query('SELECT pg_terminate_backend($1)', [victims[0]]);
    expect(await done, err).toBe(4);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.commitUnconfirmed).toEqual([expect.objectContaining({ entity: 'item', n: 1, toolRefused: true, toolReported: null,
      error: expect.stringMatching(/^the tool refused this batch \(.*\); its COMMIT was not confirmed: the connection was lost \(terminating connection/) })]);
    expect(err).not.toMatch(/from the dry run's answer/);
    expect((await pool.query(`SELECT selling_price_excl::TEXT AS p FROM items WHERE company_id = $1 AND code = 'FIB-0001'`, [s.companyId])).rows[0].p).toBe(price);
  }, 400_000);

  it('B21-2: an 08006 the books raise at the COMMIT on a live connection: unconfirmed, never "the connection was lost"', async () => {
    const company = s.companyId.replace(/[^0-9a-f-]/g, '');
    await pool.query(`CREATE OR REPLACE FUNCTION public.b21_08() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'b21 fake connection failure' USING ERRCODE = '08006'; END $$;
      CREATE CONSTRAINT TRIGGER b21f_${tag()} AFTER INSERT ON items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.company_id = '${company}' AND NEW.code = 'FIB-0001') EXECUTE FUNCTION public.b21_08();`);
    const report = join(d, 'report.json');
    const r = spawnSync('bun', args(report, []), { encoding: 'utf8', timeout: 170_000, env: env() });
    expect(r.status, r.stderr).toBe(4);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.message).toMatch(/the COMMIT of item batch 1 .* did not answer \(b21 fake connection failure\)/);
    expect(JSON.stringify(rep)).not.toMatch(/connection was lost/);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 180_000);
});

