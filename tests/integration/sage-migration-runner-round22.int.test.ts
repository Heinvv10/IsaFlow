/**
 * Round-19 breaker B19-1 through the CLI on a real database: the backend of a live batch is killed while the batch waits inside its request
 * (a test connection holds `items` in SHARE mode right after the first live category, so the item batch's inserts wait; then
 * pg_terminate_backend on the waiting backend). With the client's 'error' listened to in withToolSession, the run takes its designed
 * path: exit 4 through CommitUnconfirmedError (not "an uncaught error ended the run"), the committed categories checked against the books,
 * the item batch listed commit unconfirmed as a LOST CONNECTION, never "the tool refused this batch".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
  it('exit 4 by the designed path: the categories committed, the item batch commit unconfirmed as a lost connection, nothing of it written', async () => {
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
    expect(rep).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/the COMMIT of item batch 1 .* did not answer \(the connection was lost; its COMMIT was not confirmed/) });
    expect(rep.message).not.toMatch(/stopped at once|tool refused/);
    expect(rep.committed.map((b: { entity: string; n: number }) => `${b.entity} ${b.n}`)).toEqual(['category 1', 'category 2', 'category 3', 'category 4']);
    expect(rep.commitUnconfirmed).toEqual([expect.objectContaining({ entity: 'item', n: 1, commitUnconfirmed: true, error: expect.stringMatching(/^the connection was lost; its COMMIT was not confirmed/) })]);
    expect(rep.commitUnconfirmed[0].toolRefused).toBeUndefined();
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0 });
  }, 180_000);
});
