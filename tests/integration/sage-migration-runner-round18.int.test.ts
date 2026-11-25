/**
 * Round-15 breaker findings through the CLI on a real database (b15 repros ported):
 *   - B15-1: --report never overwrites the export: a hard link to it, --file and --report swapped, --file given twice with a dangling
 *     value; each is exit 2 and the export is left byte for byte;
 *   - B15-2: a run refused by the run lock (another run holds it) never touches --report;
 *   - B15-3: a --report that cannot be written is exit 2 before anything is written (a live run included).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { migrationLockKey } from '@/modules/accounting/services/sage-migration/sageRunLock';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r18-')); }, 120_000);
afterEach(async () => { rmSync(d, { recursive: true, force: true }); await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const FIXTURE = 'tests/fixtures/sage-export/sage-export.json';
const cli = (args: string[]) => spawnSync('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', ...args], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable' } });
const who = () => ['--company', s.companyId, '--user', s.userId];
const exportCopy = () => { const f = join(d, 'export.json'); copyFileSync(FIXTURE, f); return f; };

describe('B15-1: --report never overwrites the export', () => {
  it('a hard link, a swap, and --file twice with a dangling value: exit 2, the export byte for byte', () => {
    const file = exportCopy();
    const bytes = readFileSync(file, 'utf8');
    linkSync(file, join(d, 'link.json'));
    for (const args of [
      ['--file', file, '--report', join(d, 'link.json'), ...who(), '--expect-items', 'x'],
      ['--report', file, '--file', join(d, 'report.json'), ...who()],
      ['--file', file, '--report', file, '--file', '--live'],
    ]) {
      const r = cli(args);
      expect(r.status, args.join(' ')).toBe(2);
      // The hard link and the repeated --file are the export itself (dev + ino, every --file); the swap names a path that exists (round 16).
      // (The dangling --file --live is refused by the strict parse itself since round 16, before --report is looked at: stderr only.)
      expect(r.stderr, args.join(' ')).toMatch(args.includes('--live') ? /argument is ambiguous/ : args[3] === join(d, 'link.json') ? /is the export --file itself/ : /already exists/);
      expect(readFileSync(file, 'utf8'), args.join(' ')).toBe(bytes);
    }
  }, 180_000);
  it('round 16: a report of an earlier run is NOT replaced either (any existing path is refused); a new path is written', () => {
    const report = join(d, 'report.json');
    writeFileSync(report, JSON.stringify({ status: 'completed' }));
    const r = cli(['--file', FIXTURE, '--report', report, ...who()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/already exists: .*pick a new path or delete the old file \(nothing written; --report .* was not created by this run\)/);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ status: 'completed' });
    const fresh = join(d, 'fresh.json');
    expect(cli(['--file', FIXTURE, '--report', fresh, ...who()]).status).toBe(0);
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toMatchObject({ status: 'dry_run_ok' });
  }, 180_000);
});

describe('B15-2: a run refused by the run lock', () => {
  it('leaves the --report of the run that holds the lock as it is', async () => {
    const report = join(d, 'report.json');
    writeFileSync(report, JSON.stringify({ status: 'running', startedAt: 'run A' }));
    const holder = await pool.connect();
    try {
      const [k1, k2] = migrationLockKey(s.companyId);
      await holder.query('SELECT pg_advisory_lock($1, $2)', [k1, k2]);
      const r = cli(['--file', FIXTURE, '--report', report, ...who(), '--live', '--expect-items', '20', '--expect-pos', '10']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/already exists/); // round 16: refused at the create, before the lock is even asked
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ status: 'running', startedAt: 'run A' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  }, 180_000);
});

describe('B15-3: a --report that cannot be written', () => {
  it('a live run is exit 2 before anything is written', async () => {
    for (const report of [d, join(d, 'no-such-dir', 'r.json')]) {
      const r = cli(['--file', FIXTURE, '--report', report, ...who(), '--live', '--expect-items', '20', '--expect-pos', '10']);
      expect(r.status, report).toBe(2);
      expect(r.stderr, report).toMatch(/cannot be written|already exists/); // a directory exists: refused at the create
    }
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0, toolCalls: 0 });
  }, 180_000);
});
