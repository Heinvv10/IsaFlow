/**
 * Round-16 findings through the CLI on a real database, under the structural --report rule (the path must not exist; the run creates it
 * exclusively and writes only the file it created):
 *   - B16-1 / R16-F1: while run A holds the company's lock with its "running" report, a second run B given the SAME --report and a typo,
 *     a missing --file or another company is refused (exit 2) and A's file is left byte for byte;
 *   - B16-2 / R16-F2: another tool's status file that looks like a report (Playwright's .last-run.json) is refused, left as it is;
 *   - the path swapped under a running run (replaced by a hard link to the export) is never written: the export is left byte for byte.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r19-')); }, 120_000);
afterEach(async () => { rmSync(d, { recursive: true, force: true }); await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const FIXTURE = 'tests/fixtures/sage-export/sage-export.json';
const cli = (args: string[], env: Record<string, string> = {}, preload?: string) => spawnSync('bun', ['--no-env-file', ...(preload ? ['--preload', join(process.cwd(), preload)] : []),
  'scripts/sage-migration/run.ts', ...args], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', ...env } });

describe('B16-1 / R16-F1: a second run refused before the lock', () => {
  it('a typo, a missing --file, another company: exit 2, run A\'s "running" report byte for byte', async () => {
    const report = join(d, 'shared-report.json');
    const a = JSON.stringify({ status: 'running', startedAt: 'run A (holds the lock)' });
    writeFileSync(report, a);
    const holder = await pool.connect();
    try {
      const [k1, k2] = migrationLockKey(s.companyId);
      await holder.query('SELECT pg_advisory_lock($1, $2)', [k1, k2]);
      for (const args of [
        ['--company', s.companyId, '--user', s.userId, '--file', FIXTURE, '--report', report, '--live', '--expect-items', '12x', '--expect-pos', '10'],
        ['--company', s.companyId, '--user', s.userId, '--file', join(d, 'no-such.json'), '--report', report],
        ['--company', s.otherCompanyId, '--user', s.userId, '--file', FIXTURE, '--report', report],
        ['--company', s.companyId, '--user', s.userId, '--file', FIXTURE, '--report', report], // the same command as A
      ]) {
        const r = cli(args);
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr, args.join(' ')).toMatch(/already exists/);
        expect(readFileSync(report, 'utf8'), args.join(' ')).toBe(a);
      }
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  }, 180_000);
});

describe('B16-2 / R16-F2: another tool\'s status file', () => {
  it('shaped like a report ({"status":"failed",...}) is refused and left as it is', () => {
    const report = join(d, '.last-run.json');
    const other = JSON.stringify({ status: 'failed', failedTests: ['a.spec.ts'], note: 'NOT a sage-migration report' });
    writeFileSync(report, other);
    const r = cli(['--company', s.companyId, '--user', s.userId, '--file', FIXTURE, '--report', report, '--expect-pos', 'x']);
    expect(r.status).toBe(2);
    expect(readFileSync(report, 'utf8')).toBe(other);
  }, 180_000);
});

describe('the --report path swapped under a running run', () => {
  it('replaced by a hard link to the export: the report is not written there (exit 3), the export byte for byte; the run booked', async () => {
    const exportCopy = join(d, 'export.json');
    copyFileSync(FIXTURE, exportCopy);
    const bytes = readFileSync(exportCopy, 'utf8');
    const report = join(d, 'report.json');
    const r = cli(['--company', s.companyId, '--user', s.userId, '--file', exportCopy, '--report', report, '--live', '--expect-items', '20', '--expect-pos', '10'],
      { SAGE_SWAP_REPORT: report, SAGE_SWAP_TO: exportCopy }, 'tests/integration/helpers/sageSwapReportPreload.ts');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/is no longer the file this run created/);
    expect(readFileSync(exportCopy, 'utf8')).toBe(bytes);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
  }, 180_000);
});
