/**
 * Round-15 review R15-M2 and breaker B15-2 / B15-3: what scripts/sage-migration/run.ts leaves at --report on its exit paths, against a
 * MOCKED runner (nothing connects). The runner mock calls opts.onLocked() first, as the real one does once it holds the run lock.
 *   - every exit after the report is known safe leaves a report there: a summary that fails after a DRY run (it escaped before) leaves a
 *     stop report, not the "running" placeholder;
 *   - a refusal by the run lock (RunInProgressError: another run holds it) never touches --report;
 *   - a --report that cannot be written ends the run in onLocked, before anything else: exit 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ behave: 'bad-report' as 'bad-report' | 'locked-out', onLockedThrew: null as unknown }));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => {
  return {
    runSageMigration: vi.fn(async (_pool: unknown, _parsed: unknown, o: { onLocked?: () => void }) => {
      // Imported at the call, from the same module registry run.ts was (re)loaded in, so instanceof holds.
      const { RunInProgressError } = await import('@/modules/accounting/services/sage-migration/sageRunLock');
      if (h.behave === 'locked-out') throw new RunInProgressError('another Sage migration is running for this company');
      try { o.onLocked?.(); } catch (err) { h.onLockedThrew = err; throw err; }
      return { live: null }; // a dry run's report the summary cannot read: summarize throws after a dry run
    }),
  };
});

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-report-'));
  h.onLockedThrew = null;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

async function runCli(report: string): Promise<ReturnType<typeof vi.fn>> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', '00000000-0000-4000-8000-000000000001', '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', report];
  try {
    await import('../../../../scripts/sage-migration/run');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  } finally { process.argv = argv; }
  return exit as never;
}

describe('R15-M2: a summary that fails after a dry run', () => {
  it('leaves a stop report, not the "running" placeholder; exit 2', async () => {
    h.behave = 'bad-report';
    const report = join(d, 'report.json');
    const exit = await runCli(report);
    expect(exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false });
  });
});

describe('B15-2: a run refused by the run lock', () => {
  it('never touches --report (it belongs to the run that holds the lock)', async () => {
    h.behave = 'locked-out';
    const report = join(d, 'report.json');
    writeFileSync(report, JSON.stringify({ status: 'running', startedAt: 'A' }));
    const exit = await runCli(report);
    expect(exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ status: 'running', startedAt: 'A' });
  });
});

describe('B15-3 / R15-L3: a --report that cannot be written', () => {
  it('ends the run in onLocked, before anything else of it: exit 2, nothing written', async () => {
    h.behave = 'bad-report';
    const report = join(d, 'no-such-dir', 'report.json');
    const exit = await runCli(report);
    expect(exit).toHaveBeenCalledWith(2);
    expect(String(h.onLockedThrew)).toMatch(/--report .* cannot be written: nothing was written/);
    expect(existsSync(report)).toBe(false);
  });
});
