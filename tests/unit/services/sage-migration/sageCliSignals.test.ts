/**
 * Round 18 (decision + R18-7): run.ts's signal and stream handlers, against a MOCKED runner that reports progress and waits on a gate
 * (nothing connects); the --report file is real. Only the listeners runCli installs are fired (never vitest's own), and they are gone
 * once runCli ends (R18-3). Held here:
 *   - the first SIGINT / SIGTERM / SIGHUP makes shouldStop answer, with stderr matching the phase;
 *   - a second signal ends the run at once: in the live phase exit 4, the stop report listing the batches recorded and the one in flight
 *     as commit unconfirmed (B18-1); before it exit 2, "nothing was written to the books" (B18-3);
 *   - after the run finished (its report written), a second signal changes neither the report nor the exit code;
 *   - a stdout that fails (EPIPE) is no longer written and does not end the run (B18-2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchReport, MigrationOptions } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));

const h = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const s = {
    opts: null as MigrationOptions | null, phase: 'dry' as 'dry' | 'live', poolEnded: 0, ignoreStop: false, failFinal: false,
    gate: Promise.resolve(), poolGate: Promise.resolve(),
    arm() { s.gate = new Promise<void>((r) => { open = r; }); },
    release() { open(); },
  };
  return s;
});
const batch = (entity: BatchReport['entity'], n: number): BatchReport => ({ entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { outcome: 'created' }, error: null });
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async (_p: unknown, _x: unknown, opts: MigrationOptions) => {
    h.opts = opts;
    opts.onProgress?.({ kind: 'phase', phase: 'dry' });
    if (h.phase === 'live') {
      opts.onProgress?.({ kind: 'phase', phase: 'live' });
      opts.onProgress?.({ kind: 'sending', batch: { entity: 'category', n: 1, size: 1, key: 'k-category-1' } });
      opts.onProgress?.({ kind: 'recorded', phase: 'live', batch: batch('category', 1) });
      opts.onProgress?.({ kind: 'sending', batch: { entity: 'item', n: 1, size: 20, key: 'k-item-1' } });
    }
    await h.gate;
    const stop = opts.shouldStop?.();
    if (stop && !h.ignoreStop) throw new Error(stop);
    return { live: null, marker: 'THE-FINAL-REPORT' };
  }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', () => ({ CONSOLE_ERROR_CHARS: 600, summaryLines: () => ['SUMMARY LINE'], exitCodeFor: () => 0 }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    if (h.failFinal && String(buf).includes('THE-FINAL-REPORT')) throw new Error('EFBIG: injected');
    return (real.writeSync as (...x: unknown[]) => number)(fd, buf, ...rest);
  }) as typeof real.writeSync;
  return { ...real, default: { ...real, writeSync }, writeSync };
});
vi.mock('pg', () => ({ default: { Pool: class { on() { return this; } async end() { h.poolEnded++; await h.poolGate; } } } }));

let d: string;
let out: string[];
let err: string[];
let exit: ReturnType<typeof vi.spyOn>;
const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const HOOKS = ['uncaughtException', 'unhandledRejection'] as const;
let before: Record<string, Function[]>;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-signals-'));
  Object.assign(h, { opts: null, phase: 'dry', poolEnded: 0, poolGate: Promise.resolve(), ignoreStop: false, failFinal: false });
  h.arm();
  out = []; err = [];
  process.exitCode = undefined;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  before = Object.fromEntries([...EVENTS, ...HOOKS, 'stdout-error'].map((e) => [e, e === 'stdout-error' ? process.stdout.listeners('error') : process.listeners(e)]));
});
afterEach(() => { process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

/** The listeners runCli added (never vitest's). */
const added = (e: string): Function[] => (e === 'stdout-error' ? process.stdout.listeners('error') : process.listeners(e as NodeJS.Signals)).filter((l) => !before[e]!.includes(l));
const fire = (sig: string, arg: unknown = sig) => { const ls = added(sig); expect(ls.length, sig).toBeGreaterThan(0); for (const l of ls) l(arg); };
const report = () => join(d, 'report.json');
const json = () => JSON.parse(readFileSync(report(), 'utf8'));
async function start(extra: string[] = []) {
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', '00000000-0000-4000-8000-000000000001', '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', report(), ...extra];
  const { runCli } = await import('../../../../scripts/sage-migration/run');
  const done = runCli({ removeHandlers: true }).finally(() => { process.argv = argv; });
  await vi.waitFor(() => expect(h.opts).not.toBeNull());
  return { done }; // wrapped: an async function returning the promise itself would wait for it
}
const code = () => (exit.mock.calls.length > 0 ? Number(exit.mock.calls[0]![0] ?? process.exitCode ?? 0) : process.exitCode);

describe('the first signal', () => {
  for (const sig of EVENTS) {
    it(`${sig} in the dry run: shouldStop answers, stderr says nothing is written; the run stops (exit 2), handlers removed after`, async () => {
      const { done } = await start();
      fire(sig);
      expect(h.opts!.shouldStop!()).toBe(`stopped by ${sig}: no further batch is sent; nothing was written to the books`); // R19-6
      expect(err.join('')).toMatch(new RegExp(`${sig}: the run stops before its next batch, if one remains; nothing is written to the books`));
      h.release();
      await done;
      expect(code()).toBe(2);
      expect(json()).toMatchObject({ status: 'stopped', liveStarted: false });
      for (const e of EVENTS) expect(added(e), e).toEqual([]);
      expect(added('stdout-error')).toEqual([]);
    });
  }
  it('in the live phase: stderr says what it committed is listed', async () => {
    h.phase = 'live';
    const { done } = await start(['--live', '--expect-items', '20', '--expect-pos', '10']);
    fire('SIGTERM');
    expect(err.join('')).toMatch(/SIGTERM: the live run stops before its next batch, if one remains; what it committed is then listed/);
    expect(h.opts!.shouldStop!()).toBe('stopped by SIGTERM: no further batch is sent'); // live: no "nothing written"
    h.release();
    await done;
  });
});

describe('a second signal: the run ends at once', () => {
  it('live (B18-1): exit 4, the report lists the recorded batch as committed and the one in flight as commit unconfirmed', async () => {
    h.phase = 'live';
    const { done } = await start(['--live', '--expect-items', '20', '--expect-pos', '10']);
    fire('SIGTERM');
    fire('SIGTERM');
    expect(code()).toBe(4);
    const r = json();
    expect(r).toMatchObject({ status: 'stopped', liveStarted: true, message: expect.stringMatching(/stopped at once by a second signal \(SIGTERM\).*not re-checked against the books/s) });
    expect(r.committed.map((b: BatchReport) => `${b.entity} ${b.n}`)).toEqual(['category 1']);
    expect(r.commitUnconfirmed.map((b: BatchReport) => `${b.entity} ${b.n}`)).toEqual(['item 1']);
    h.release();
    await done;
    // R19-1: terminate closed the file, so the usual stop that follows (process.exit is mocked here) cannot replace the stop at once.
    expect(json().message).toMatch(/stopped at once by a second signal/);
  });
  it('R19-1: an unhandled rejection ends it at once through the same path (dry: exit 2, nothing written said once)', async () => {
    const { done } = await start();
    fire('unhandledRejection', new Error('boom'));
    expect(code()).toBe(2);
    expect(json()).toMatchObject({ status: 'stopped', liveStarted: false, message: expect.stringMatching(/an unhandled rejection ended the run: boom; nothing was written to the books/) });
    expect(err.join('').match(/nothing (was )?written/g)).toHaveLength(1); // R19-6: said once (here the file exists: no note)
    h.release();
    await done;
  });
  it('dry run (B18-3): exit 2, "nothing was written to the books", never 4', async () => {
    const { done } = await start();
    fire('SIGINT');
    fire('SIGHUP');
    expect(code()).toBe(2);
    expect(json()).toMatchObject({ status: 'stopped', liveStarted: false, committed: [], message: expect.stringMatching(/second signal \(SIGHUP\); nothing was written to the books/) });
    h.release();
    await done;
  });
  it('after the run finished (its report written): the report and the exit code stand', async () => {
    let openPool: () => void = () => undefined;
    h.poolGate = new Promise<void>((r) => { openPool = r; });
    const { done } = await start();
    h.release();
    await vi.waitFor(() => expect(h.poolEnded).toBe(1));
    fire('SIGTERM');
    expect(err.join('')).toMatch(/SIGTERM: the run had finished; its report and exit code stand\n$/); // B20-3: no promise of a list
    expect(err.join('')).not.toMatch(/stops before its next batch/);
    fire('SIGTERM');
    expect(exit.mock.calls[0]).toEqual([]); // process.exit() keeps process.exitCode (0)
    expect(json()).toMatchObject({ marker: 'THE-FINAL-REPORT' });
    openPool();
    await done;
    expect(process.exitCode).toBe(0);
  });
});

describe('B19-2: a signal during the last batch (none left to stop before)', () => {
  it('the run finishes as it is (exit 0, its report), and a closing line says the signal came after the last batch', async () => {
    h.ignoreStop = true; // the runner asks shouldStop only before a batch: none followed
    const { done } = await start();
    fire('SIGTERM');
    h.release();
    await done;
    expect(process.exitCode).toBe(0);
    expect(json()).toMatchObject({ marker: 'THE-FINAL-REPORT' });
    expect(err.join('')).toMatch(/SIGTERM came after the run's last stop check: the run finished \(exit 0\)\n$/); // said last (R20-3)
  });
  it('R20-3: with the report not written, the closing line comes after that and gives the final exit code (3)', async () => {
    h.ignoreStop = true;
    h.failFinal = true;
    const { done } = await start();
    fire('SIGTERM');
    h.release();
    await done;
    expect(process.exitCode).toBe(3);
    expect(err.join('')).toMatch(/the report was not written: .*EFBIG: injected[\s\S]*SIGTERM came after the run's last stop check: the run finished \(exit 3\)\n$/);
  });
});

describe('B18-2: a stdout whose reader went away', () => {
  it('is no longer written; the run goes on to exit 0 with its report', async () => {
    const { done } = await start();
    fire('stdout-error', Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }));
    fire('stdout-error', Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }));
    h.release();
    await done;
    expect(out.join('')).not.toContain('SUMMARY LINE');
    expect(err.join('').match(/stdout is closed \(EPIPE\)/g)).toHaveLength(1); // B19-3: said once
    expect(process.exitCode).toBe(0);
    expect(json()).toMatchObject({ marker: 'THE-FINAL-REPORT' });
  });
});
