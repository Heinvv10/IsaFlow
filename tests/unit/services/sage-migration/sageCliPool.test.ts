/**
 * Round 26 (B26-1, R26-3) on run.ts, against a MOCKED runner and pg pool: a notice the runner gives reaches stderr; the stop message is
 * said BEFORE the pool is ended (a pool that never ends cannot swallow it); a pool that does not close within SAGE_POOL_END_TIMEOUT_MS
 * is said, and the process exits with the run's own code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ behave: 'ok' as 'ok' | 'locked-out', endHangs: false, poolEnded: 0, noticed: '' }));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async (_p: unknown, _x: unknown, o: { onNotice?: (l: string) => void }) => {
    if (h.noticed) o.onNotice?.(h.noticed);
    const { RunInProgressError } = await import('@/modules/accounting/services/sage-migration/sageRunLock');
    if (h.behave === 'locked-out') throw new RunInProgressError('another Sage migration is running for this company');
    return { live: null };
  }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', () => ({ CONSOLE_ERROR_CHARS: 600, summaryLines: () => ['SUMMARY LINE'], exitCodeFor: () => 0 }));
vi.mock('pg', () => ({ default: { Pool: class { on() { return this; } end() { h.poolEnded++; return h.endHangs ? new Promise(() => undefined) : Promise.resolve(); } } } }));

let d: string;
let err: string[];
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-pool-'));
  Object.assign(h, { behave: 'ok', endHangs: false, poolEnded: 0, noticed: '' });
  err = [];
  process.exitCode = undefined;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => { process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

async function runCli(): Promise<void> {
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', '00000000-0000-4000-8000-000000000001', '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', join(d, 'report.json')];
  try {
    const { runCli: cli } = await import('../../../../scripts/sage-migration/run');
    await cli({ removeHandlers: true });
  } finally { process.argv = argv; }
}

describe('R26-3: a notice the runner gives', () => {
  it('reaches stderr as it is', async () => {
    h.noticed = 'a database request has had no answer for 5 s; it is blocked by backend pid 7';
    await runCli();
    expect(err.join('')).toContain('a database request has had no answer for 5 s; it is blocked by backend pid 7\n');
  });
});

describe('B26-1: the pool is ended last, and bounded', () => {
  it('a stop: its message is said and the process exits, the pool not even waited for', async () => {
    h.behave = 'locked-out';
    h.endHangs = true;
    await runCli();
    expect(err.join('')).toMatch(/another Sage migration is running for this company/);
    expect(exit).toHaveBeenCalledWith(2);
    expect(h.poolEnded).toBe(0);
  });
  it('a finished run whose pool never closes: said after the summary, and the process exits with the run\'s code', async () => {
    h.endHangs = true;
    const { SAGE_POOL_END_TIMEOUT_MS } = await import('@/modules/accounting/services/sage-migration/sageTimeouts');
    const t0 = Date.now();
    await runCli();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SAGE_POOL_END_TIMEOUT_MS - 100);
    expect(err.join('')).toMatch(/closing the database pool did not finish within 5 s: the run's result above stands \(exit 0\)/);
    expect(exit).toHaveBeenCalledWith(0);
  }, 20_000);
  it('a pool that closes: no exit forced', async () => {
    await runCli();
    expect(h.poolEnded).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
