/**
 * R29-1 (B29-1), R29-2, R29-9, B29-4 on run.ts / runEnd.ts, against a MOCKED runner that sends batches one by one, asking shouldStop
 * before each, as the real one does; the console's stderr is STALLED (a reader that does not read), so every exit has to wait for it.
 *   - an uncaught error / an unhandled rejection in the live phase ends the run: no batch is sent after it, the batch in flight settles
 *     and is said as such, and the books (what the runner sent), the report and the console agree; no summary, no exit code from main;
 *   - the same in the dry phase: the live phase never starts, exit 2;
 *   - a stray error while the exit waits changes nothing (R29-2); a first signal then says the run has already stopped (B29-4) and a
 *     second one exits at once, the code unchanged; after a finished run a second signal exits at once (R29-9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchReport, MigrationOptions } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const h = vi.hoisted(() => ({
  opts: null as MigrationOptions | null, phase: 'live' as 'dry' | 'live', batches: 8, sent: [] as string[], liveEntered: false,
  crashAt: null as number | null, crash: (() => undefined) as () => void, throwAtEnd: null as string | null,
  poolGate: Promise.resolve() as Promise<void>, endedSeen: null as string | null,
  inFlightGate: Promise.resolve() as Promise<void>, failRewrite: false, stopWrites: 0,
}));
const batch = (entity: BatchReport['entity'], n: number): BatchReport => ({ entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { outcome: 'created' }, error: null });
const tick = () => new Promise((r) => setImmediate(r));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async (_p: unknown, _x: unknown, opts: MigrationOptions) => {
    h.opts = opts;
    const phases = h.phase === 'dry' ? ['dry'] as const : ['dry', 'live'] as const;
    for (const phase of phases) {
      opts.onProgress?.({ kind: 'phase', phase });
      if (phase === 'live') h.liveEntered = true;
      for (let n = 1; n <= (phase === 'dry' && h.phase === 'live' ? 0 : h.batches); n++) {
        const stop = opts.shouldStop?.();
        if (stop) throw new Error(stop);
        opts.onProgress?.({ kind: 'sending', batch: { entity: 'category', n, size: 1, key: `k-category-${n}` } });
        if (n === h.crashAt) { h.crash(); h.endedSeen = opts.ended?.() ?? null; } // the crash comes while this batch is in flight
        await tick();
        if (n === h.crashAt) await h.inFlightGate; // the batch in flight answers late (or never)
        h.sent.push(`${phase} ${n}`);
        opts.onProgress?.({ kind: 'recorded', phase, batch: batch('category', n) });
      }
    }
    if (h.throwAtEnd) throw new Error(h.throwAtEnd);
    return { live: null, marker: 'THE-FINAL-REPORT' };
  }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', () => ({ CONSOLE_ERROR_CHARS: 600, summaryLines: () => ['SUMMARY LINE'], exitCodeFor: () => 0 }));
// R30-4: the second stop report (the rewrite once the batch in flight settled) can be made to fail.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(buf) && buf.includes('"status": "stopped"') && ++h.stopWrites === 2 && h.failRewrite) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    return (real.writeSync as (...x: unknown[]) => number)(fd, buf, ...rest);
  }) as typeof real.writeSync;
  return { ...real, default: { ...real, writeSync }, writeSync };
});
vi.mock('pg', () => ({ default: { Pool: class { on() { return this; } async end() { await h.poolGate; } } } }));
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));

const stall = (on: boolean) => { (globalThis as { __sageConsoleStall?: unknown }).__sageConsoleStall = { stderr: on }; };
let d: string;
let err: string[];
let exit: ReturnType<typeof vi.spyOn>;
let before: Record<string, Function[]>;
const HOOKS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'sage-cli-end-'));
  Object.assign(h, { opts: null, phase: 'live', batches: 8, sent: [], liveEntered: false, crashAt: null, crash: () => undefined, throwAtEnd: null, poolGate: Promise.resolve(), endedSeen: null, inFlightGate: Promise.resolve(), failRewrite: false, stopWrites: 0 });
  err = [];
  process.exitCode = undefined;
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
  for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  before = Object.fromEntries(HOOKS.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
  stall(true);
});
afterEach(() => { stall(false); process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(d, { recursive: true, force: true }); });

const fire = (ev: (typeof HOOKS)[number], arg: unknown = ev) => { for (const l of process.listeners(ev as NodeJS.Signals).filter((x) => !before[ev]!.includes(x))) (l as (a: unknown) => void)(arg); };
const report = () => JSON.parse(readFileSync(join(d, 'r.json'), 'utf8'));
async function start() {
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', '00000000-0000-4000-8000-000000000001', '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', join(d, 'r.json'), '--live', '--expect-items', '20', '--expect-pos', '10'];
  const { runCli } = await import('../../../../scripts/sage-migration/run');
  return { done: runCli({ removeHandlers: true }).finally(() => { process.argv = argv; }) };
}
/** Until the runner stopped asking (it threw or returned), at most 2 s. */
const settle = async () => {
  await vi.waitFor(() => expect(h.opts).not.toBeNull(), { timeout: 10_000 }); // run.ts imports its body (runMain.ts) first
  for (let i = 0; i < 200 && exit.mock.calls.length === 0; i++) await tick();
  for (let i = 0; i < 20; i++) await tick();
};

describe('R29-1: an end at once while the console is still being written stops the run for real', () => {
  for (const [what, ev] of [['an uncaught error', 'uncaughtException'], ['an unhandled rejection', 'unhandledRejection']] as const) {
    it(`live, ${what}: no batch after it; the one in flight settles and is said; books = report = console; no summary, exit 4 once drained`, async () => {
      h.crashAt = 3;
      h.crash = () => fire(ev, new Error('injected'));
      const { done } = await start();
      await settle();
      expect(h.sent).toEqual(['live 1', 'live 2', 'live 3']); // never batch 4 (shouldStop answered)
      expect(h.endedSeen).toMatch(/ended the run: injected/); // and the runner's sessions would refuse (MigrationOptions.ended)
      expect(exit).not.toHaveBeenCalled(); // the stop message still waits for its reader
      const r = report();
      expect(r).toMatchObject({ status: 'stopped', liveStarted: true });
      expect(r.committed.map((b: BatchReport) => b.n)).toEqual([1, 2, 3]); // batch 3 settled after the end: written into the report as it settled
      expect(r.commitUnconfirmed).toEqual([]);
      stall(false);
      await done;
      expect(exit.mock.calls).toEqual([[4]]);
      const said = err.join('');
      expect(said).toMatch(/sage migration stopped: an (uncaught error|unhandled rejection) ended the run: injected/);
      expect(said).toMatch(/committed: category batch 1 .*\n.*committed: category batch 2 /s);
      expect(said).toMatch(/commit unconfirmed: category batch 3 /); // as known at the end...
      expect(said).toContain('the batch in flight when the run ended, category batch 3 (k-category-3), then committed; no batch followed it: the report says so'); // ...then as it settled
      expect(said).not.toMatch(/SUMMARY LINE|the run finished|report was not written/);
      expect(said).not.toMatch(/the run had ended \(/); // the runner's own stop that followed says nothing
      expect(report().message).toMatch(/ended the run: injected \(stopped at once/); // and writes nothing over the stop report
    });
  }
  it('dry: the live phase never starts; exit 2, "nothing was written to the books"', async () => {
    h.phase = 'dry';
    h.crashAt = 2;
    h.crash = () => fire('uncaughtException', new Error('injected'));
    const { done } = await start();
    await settle();
    expect(h.sent).toEqual(['dry 1', 'dry 2']);
    expect(h.liveEntered).toBe(false);
    expect(report()).toMatchObject({ status: 'stopped', liveStarted: false });
    stall(false);
    await done;
    expect(exit.mock.calls).toEqual([[2]]);
    expect(err.join('')).toContain('nothing was written to the books (the live phase had not started)');
  });
});

describe('R29-1: an end at once during the last batch', () => {
  it('the runner then returns as if finished: main prints no summary, writes no report, sets no exit code', async () => {
    h.batches = 3;
    h.crashAt = 3;
    h.crash = () => fire('uncaughtException', new Error('injected'));
    const { done } = await start();
    await settle();
    stall(false);
    await done;
    expect(exit.mock.calls).toEqual([[4]]);
    expect(err.join('')).not.toMatch(/SUMMARY LINE|the run finished|report was not written/);
    expect(report()).toMatchObject({ status: 'stopped', liveStarted: true });
    expect(report().marker).toBeUndefined(); // never the run's own report over the stop report
  });
});

describe('R29-2 / B29-4 / R29-9: what else comes while the exit waits', () => {
  it('a stray error changes nothing; a first signal says the run has already stopped; a second exits at once, the code unchanged', async () => {
    h.throwAtEnd = 'the books refused it'; // an ERROR stop of the run itself (a plain error: exit 2 here)
    const { done } = await start();
    await settle();
    fire('uncaughtException', new Error('late pg client error'));
    for (let i = 0; i < 20; i++) await tick();
    expect(exit).not.toHaveBeenCalled(); // R29-2: never cuts the stop message
    fire('SIGINT');
    for (let i = 0; i < 20; i++) await tick();
    expect(exit).not.toHaveBeenCalled();
    fire('SIGINT');
    expect(exit.mock.calls).toEqual([[2]]); // at once, the stop's own code
    stall(false);
    await done;
    expect(err.join('')).toContain('SIGINT: the run has already stopped; its stop message is still being written (send it again to exit at once)');
    expect(err.join('')).not.toMatch(/stops before its next batch/);
  });
  it('R29-9: after a finished run, a second signal exits at once', async () => {
    h.batches = 1;
    let open: () => void = () => undefined;
    h.poolGate = new Promise((r) => { open = r; }); // the run has finished; its pool is still closing: the handlers are still there
    const { done } = await start();
    await settle();
    fire('SIGTERM'); // the run had finished: said (queued behind the stalled reader)
    expect(exit).not.toHaveBeenCalled();
    fire('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    stall(false);
    open();
    await done;
  });
});

describe('R30-1: an end at once waits for the batch in flight, whatever the console does', () => {
  it('a HEALTHY console: the batch in flight settles first, is said and written into the report, then exit 4', async () => {
    stall(false);
    let open: () => void = () => undefined;
    h.inFlightGate = new Promise((r) => { open = r; });
    h.crashAt = 3;
    h.crash = () => fire('uncaughtException', new Error('injected'));
    const { done } = await start();
    await settle();
    expect(exit).not.toHaveBeenCalled(); // the console is written, the batch is still in flight: it waits for that
    open();
    await done;
    expect(exit.mock.calls).toEqual([[4]]);
    expect(h.sent).toEqual(['live 1', 'live 2', 'live 3']);
    expect(report().committed.map((b: BatchReport) => b.n)).toEqual([1, 2, 3]);
    expect(err.join('')).toContain('the batch in flight when the run ended, category batch 3 (k-category-3), then committed; no batch followed it: the report says so');
  });
  it('a signal during that wait ends it at once (the report keeps the batch as commit unconfirmed)', async () => {
    stall(false);
    let open: () => void = () => undefined;
    h.inFlightGate = new Promise((r) => { open = r; }); // does not answer while the test looks
    h.crashAt = 3;
    h.crash = () => fire('uncaughtException', new Error('injected'));
    const { done } = await start();
    await settle();
    fire('SIGINT');
    expect(err.join('')).toContain('SIGINT: the run has already stopped');
    expect(exit).not.toHaveBeenCalled();
    fire('SIGINT');
    expect(exit.mock.calls).toEqual([[4]]);
    expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
    open();
    await done;
  });
  it(`bounded: a batch in flight that never settles is waited for at most IN_FLIGHT_WAIT_MS, said, then exit 4`, async () => {
    stall(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let open: () => void = () => undefined;
      h.inFlightGate = new Promise((r) => { open = r; });
      h.crashAt = 3;
      h.crash = () => fire('uncaughtException', new Error('injected'));
      const { done } = await start();
      await settle();
      const { IN_FLIGHT_WAIT_MS } = await import('../../../../scripts/sage-migration/runEnd');
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS - 1_000);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exit.mock.calls).toEqual([[4]]);
      expect(err.join('')).toContain(`the batch in flight when the run ended, category batch 3 (k-category-3), did not settle within ${IN_FLIGHT_WAIT_MS / 1000} s: it stays commit unconfirmed: check the books`);
      expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
      open();
      await done;
    } finally { vi.useRealTimers(); }
  });
  it('R30-4: a rewrite that fails keeps the first stop report, never the small "not written" body', async () => {
    stall(false);
    h.failRewrite = true;
    h.crashAt = 3;
    h.crash = () => fire('uncaughtException', new Error('injected'));
    const { done } = await start();
    await settle();
    await done;
    const r = report();
    expect(r.status).toBe('stopped');
    expect(r.committed.map((b: BatchReport) => b.n)).toEqual([1, 2]); // the first report, with batch 3 still in flight
    expect(r.commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
    expect(err.join('')).toContain('(the stop report written before it is kept)');
  });
});

describe('B30-2: a second signal that ends the run at once ends the process at once too', () => {
  it('the first stop not reached yet (a batch in flight): the stop report is written and the process exits, the console not waited for', async () => {
    let open: () => void = () => undefined;
    h.inFlightGate = new Promise((r) => { open = r; });
    h.crashAt = 3;
    h.crash = () => { fire('SIGINT'); fire('SIGINT'); };
    const { done } = await start();
    await settle();
    expect(exit.mock.calls).toEqual([[4]]); // stderr is stalled: still at once
    expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
    stall(false);
    open();
    await done;
  });
});
