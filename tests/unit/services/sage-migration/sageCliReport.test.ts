/**
 * What scripts/sage-migration/run.ts leaves at --report on its exit paths (round-16 rule, round-15 R15-M2), against a MOCKED runner
 * (nothing connects):
 *   - an existing --report (a running run's placeholder, B16-1; any other file) is never written: exit 2, before anything else, whatever
 *     the second run's mistake (a typo, a bad --file, another company);
 *   - every exit after the run created its --report leaves a report in it: a refusal after the create, a summary that fails after a dry
 *     run, a refusal by the run lock (its own new file);
 *   - a --report that cannot be created is exit 2 and the runner never runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ behave: 'bad-report' as 'bad-report' | 'locked-out', calls: 0 }));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async () => {
    h.calls++;
    // Imported at the call, from the same module registry run.ts was (re)loaded in, so instanceof holds.
    const { RunInProgressError } = await import('@/modules/accounting/services/sage-migration/sageRunLock');
    if (h.behave === 'locked-out') throw new RunInProgressError('another Sage migration is running for this company');
    return { live: null }; // a dry run's report the summary cannot read: summarize throws after a dry run
  }),
}));

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-report-'));
  h.calls = 0;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

const COMPANY = '00000000-0000-4000-8000-000000000001';
async function runCli(report: string, extra: string[] = [], company = COMPANY): Promise<ReturnType<typeof vi.fn>> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', company, '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', report, ...extra];
  try {
    await import('../../../../scripts/sage-migration/run');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  } finally { process.argv = argv; }
  return exit as never;
}

describe('B16-1 / R16-F1: an existing --report is never written', () => {
  for (const [name, extra, company] of [
    ['a typo in a count', ['--live', '--expect-items', '12x', '--expect-pos', '10'], COMPANY],
    ['a mistyped option (the strict parse throws)', ['--expect-po', '10'], COMPANY],
    ['another company', [], 'not-a-uuid'],
  ] as const) {
    it(`${name}: exit 2, the running run's placeholder left as it is, the runner never runs`, async () => {
      h.behave = 'bad-report';
      const report = join(d, 'run-a.json');
      writeFileSync(report, JSON.stringify({ status: 'running', startedAt: 'run A' }));
      const exit = await runCli(report, [...extra], company);
      expect(exit).toHaveBeenCalledWith(2);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ status: 'running', startedAt: 'run A' });
      expect(h.calls).toBe(0);
    });
  }
});

describe('every exit after the run created its --report leaves a report in it', () => {
  it('a refusal after the create (a bad --run-tag): a stop report', async () => {
    const report = join(d, 'report.json');
    expect(await runCli(report, ['--run-tag', 'bad tag!'])).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false, message: expect.stringMatching(/--run-tag must be/) });
  });
  it('R15-M2: a summary that fails after a dry run: a stop report, not the "running" placeholder', async () => {
    h.behave = 'bad-report';
    const report = join(d, 'report.json');
    expect(await runCli(report)).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false });
  });
  it('a refusal by the run lock: a stop report in the run\'s OWN new file (another run\'s report has another path)', async () => {
    h.behave = 'locked-out';
    const report = join(d, 'report.json');
    expect(await runCli(report)).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', message: expect.stringMatching(/another Sage migration is running/) });
  });
});

describe('B15-3: a --report that cannot be created', () => {
  it('exit 2 before anything else: the runner never runs, nothing is written', async () => {
    const report = join(d, 'no-such-dir', 'report.json');
    expect(await runCli(report)).toHaveBeenCalledWith(2);
    expect(existsSync(report)).toBe(false);
    expect(h.calls).toBe(0);
  });
});
