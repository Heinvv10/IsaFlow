/**
 * scripts/sage-migration/run.ts on its exit paths, against a MOCKED runner, summary and pg pool (nothing connects); the --report file is
 * real. Round 17 (decision + R17-2): --report is created only after every check that needs no database, and written only through its
 * descriptor. Held here:
 *   - a refusal before the create writes nothing anywhere, and says --report was not created; an existing --report (B16-1) is never touched;
 *   - after the create every exit leaves a report in it (a stop report, or the run's own);
 *   - the success path: the summary to stdout (to stderr when the run is exit 4), the report written, a failed final write 0 -> 3 only
 *     (a 1 stays) with a small fallback body, a pool that fails to close changing nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  behave: 'ok' as 'ok' | 'locked-out' | 'live-summary-fails',
  code: 0, calls: 0, failFinalWrite: false, poolEndThrows: false, poolEnded: 0,
}));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async () => {
    h.calls++;
    const { RunInProgressError } = await import('@/modules/accounting/services/sage-migration/sageRunLock');
    if (h.behave === 'locked-out') throw new RunInProgressError('another Sage migration is running for this company');
    return { live: h.behave === 'live-summary-fails' ? {} : null, marker: 'THE-FINAL-REPORT' };
  }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', () => ({
  CONSOLE_ERROR_CHARS: 600,
  summaryLines: () => { if (h.behave === 'live-summary-fails') throw new Error('summary bug'); return ['SUMMARY LINE']; },
  exitCodeFor: () => h.code,
}));
vi.mock('pg', () => ({ default: { Pool: class { on() { return this; } async end() { h.poolEnded++; if (h.poolEndThrows) throw new Error('end failed'); } } } }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    if (h.failFinalWrite && String(buf).includes('THE-FINAL-REPORT')) throw new Error('EIO: injected');
    return (real.writeSync as (...x: unknown[]) => number)(fd, buf, ...rest);
  }) as typeof real.writeSync;
  return { ...real, default: { ...real, writeSync }, writeSync };
});

let d: string;
let out: string[];
let err: string[];
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-report-'));
  Object.assign(h, { behave: 'ok', code: 0, calls: 0, failFinalWrite: false, poolEndThrows: false, poolEnded: 0 });
  out = []; err = [];
  process.exitCode = undefined;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
});
afterEach(() => { process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

const COMPANY = '00000000-0000-4000-8000-000000000001';
/** Runs run.ts's runCli; resolves with the exit code (process.exit, or process.exitCode once the pool closed). */
async function runCli(report: string, extra: string[] = [], file = 'tests/fixtures/sage-export/sage-export.json'): Promise<number | undefined> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', COMPANY, '--user', '00000000-0000-4000-8000-000000000002', '--file', file, '--report', report, ...extra];
  try {
    const { runCli: cli } = await import('../../../../scripts/sage-migration/run');
    await cli();
  } finally { process.argv = argv; }
  return exit.mock.calls.length > 0 ? Number(exit.mock.calls[0]![0]) : (process.exitCode as number | undefined);
}
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('a refusal before the create: nothing written anywhere', () => {
  it('a bad --run-tag, a bad count, an export that does not parse: exit 2, --report not created, the runner never runs', async () => {
    const bad = join(d, 'bad.json');
    writeFileSync(bad, '{"status":"x"}');
    const cases = [
      [['--run-tag', 'bad tag!'], undefined, /^--run-tag must be 1-32 letters/],
      [['--live', '--expect-items', '12x', '--expect-pos', '1'], undefined, /^not a count: 12x/],
      [[], bad, /^--file .*bad\.json cannot be used: .*status/], // R18-5: a refused start, not a "stop"
    ] as const;
    for (const [extra, file, said] of cases) {
      vi.resetModules();
      err.length = 0;
      const report = join(d, `r-${extra.length}-${String(file).length}.json`);
      expect(await runCli(report, [...extra], file), extra.join(' ')).toBe(2);
      expect(existsSync(report), extra.join(' ')).toBe(false);
      expect(err.join(''), extra.join(' ')).toMatch(said); // a refusal is said as it is, not as a "stop"
      expect(err.join(''), extra.join(' ')).toMatch(/\(nothing written; --report .* was not created by this run\)\n$/);
    }
    expect(h.calls).toBe(0);
  });
  it('B16-1: an existing --report (a running run\'s placeholder) is left as it is', async () => {
    const report = join(d, 'run-a.json');
    writeFileSync(report, JSON.stringify({ status: 'running', startedAt: 'run A' }));
    expect(await runCli(report)).toBe(2);
    expect(json(report)).toEqual({ status: 'running', startedAt: 'run A' });
    expect(h.calls).toBe(0);
  });
});

describe('after the create: every exit leaves a report in it', () => {
  it('a refusal by the run lock: a stop report (its own new file)', async () => {
    h.behave = 'locked-out';
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(2);
    expect(json(report)).toMatchObject({ status: 'stopped', message: expect.stringMatching(/another Sage migration is running/) });
    expect(err.join('')).not.toMatch(/was not created/);
  });
});

describe('R17-2: the success path', () => {
  it('exit 0: the summary on stdout, the run\'s report in the file', async () => {
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(0);
    expect(out.join('')).toContain('SUMMARY LINE');
    expect(err.join('')).toBe('');
    expect(json(report)).toMatchObject({ marker: 'THE-FINAL-REPORT' });
  });
  it('a summary failing after a live run: exit 4, its line on STDERR (not stdout), the report still written', async () => {
    h.behave = 'live-summary-fails';
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(4);
    expect(err.join('')).toMatch(/the live run committed; the summary failed \(summary bug\)/);
    expect(out.join('')).toBe('');
    expect(json(report)).toMatchObject({ marker: 'THE-FINAL-REPORT' });
  });
  it('a final write that fails on a run that is otherwise 0: exit 3, said so, the file holds report_not_written (R17-4)', async () => {
    h.failFinalWrite = true;
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(3);
    expect(err.join('')).toMatch(/the run finished \(exit 0 without this\) but the report was not written: .*EIO: injected/);
    expect(json(report)).toMatchObject({ status: 'report_not_written', exitCode: 3 });
  });
  it('a final write that fails on a run that is 1: the 1 stays (never hidden by a 3)', async () => {
    h.failFinalWrite = true;
    h.code = 1;
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(1);
    expect(err.join('')).toMatch(/the exit code stays 1/);
    expect(json(report)).toMatchObject({ status: 'report_not_written', exitCode: 1 });
  });
  it('R17-7: a pool that fails to close changes neither the exit code nor the report', async () => {
    h.poolEndThrows = true;
    const report = join(d, 'report.json');
    expect(await runCli(report)).toBe(0);
    expect(err.join('')).toMatch(/closing the database pool failed: end failed/);
    expect(json(report)).toMatchObject({ marker: 'THE-FINAL-REPORT' });
  });
});
