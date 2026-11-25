/**
 * Round-17 findings through the CLI on a real database, under the decision (the report is written only through the descriptor of its
 * exclusive create; no temp file, no rename):
 *   - B17-1: files planted at the names a temp file would have had survive, byte for byte;
 *   - B17-2: a file moved onto the report path during the run (the report moved away) survives; the run writes its own moved file;
 *   - B17-3: SIGTERM during the live run stops it before the next batch: exit 4, a stop report listing what was committed; a second
 *     SIGTERM stops it at once (exit 4, a stop report saying what is known).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
let d: string;
beforeEach(async () => { s = await sageWorld(pool); d = mkdtempSync(join(tmpdir(), 'sage-r20-')); }, 120_000);
afterEach(async () => { rmSync(d, { recursive: true, force: true }); await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const FIXTURE = 'tests/fixtures/sage-export/sage-export.json';
const cli = (args: string[], env: Record<string, string> = {}, preload?: string) => spawnSync('bun', ['--no-env-file', ...(preload ? ['--preload', join(process.cwd(), preload)] : []),
  'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, '--file', FIXTURE, ...args], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', ...env } });
const live = ['--live', '--expect-items', '20', '--expect-pos', '10'];

describe('B17-1: files at would-be temp names', () => {
  it('survive byte for byte; the report is written', () => {
    const report = join(d, 'r.json');
    for (let n = 0; n < 200; n++) writeFileSync(join(d, `.r.json.${n}.${Date.now() + n}.tmp`), `planted ${n}`);
    expect(cli(['--report', report]).status).toBe(0);
    const planted = readdirSync(d).filter((f) => f.endsWith('.tmp'));
    expect(planted).toHaveLength(200);
    for (const f of planted) expect(readFileSync(join(d, f), 'utf8')).toMatch(/^planted \d+$/);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'dry_run_ok' });
  }, 180_000);
});

describe('B17-2: a file moved onto the report path during the run', () => {
  it('survives; the run\'s report goes to its own (moved) file', () => {
    const [report, movedTo, victim] = [join(d, 'report.json'), join(d, 'moved.json'), join(d, 'victim.json')];
    writeFileSync(victim, 'VICTIM');
    const r = cli(['--report', report, ...live], { SAGE_REPORT: report, SAGE_MOVED_TO: movedTo, SAGE_VICTIM: victim }, 'tests/integration/helpers/sageMoveVictimPreload.ts');
    expect(r.status).toBe(0);
    expect(readFileSync(report, 'utf8')).toBe('VICTIM');
    expect(JSON.parse(readFileSync(movedTo, 'utf8'))).toMatchObject({ status: 'completed' });
  }, 180_000);
});

describe('B17-3: a signal during the live run', () => {
  it('SIGTERM after the first live COMMIT: exit 4, a stop report listing the committed batch, nothing after it sent', async () => {
    const report = join(d, 'report.json');
    const r = cli(['--report', report, ...live], { SAGE_SIGNAL_AT_COMMIT: '1' }, 'tests/integration/helpers/sageSignalAtCommitPreload.ts');
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/SIGTERM: the run stops before its next batch/);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/stopped by SIGTERM: no further batch is sent/) });
    expect(json.committed.map((b: { entity: string; n: number }) => `${b.entity} ${b.n}`)).toEqual(['category 1']);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 1, items: 0, pos: 0 });
  }, 180_000);
  it('SIGINT twice: stopped at once, exit 4, a stop report saying what is known', () => {
    const report = join(d, 'report.json');
    const r = cli(['--report', report, ...live], { SAGE_SIGNAL_AT_COMMIT: '1', SAGE_SIGNAL: 'SIGINT', SAGE_SIGNAL_TIMES: '2' }, 'tests/integration/helpers/sageSignalAtCommitPreload.ts');
    expect(r.status).toBe(4);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', message: expect.stringMatching(/stopped at once by a second SIGINT/) });
  }, 180_000);
});
