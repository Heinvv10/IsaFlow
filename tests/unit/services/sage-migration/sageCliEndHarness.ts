/**
 * The harness of the CLI end tests (sageCliEnd.test.ts, sageCliEndWait.test.ts): a MOCKED runner that sends batches one by one, asking
 * shouldStop before each, as the real one does; the console's stderr STALLED by default (a reader that does not read), so every exit
 * has to wait for it. Its state lives on globalThis: a test file's vi.mock factories import this module after vi.resetModules, so they may
 * get another instance of it than the test file's own. Each test file wires it with:
 *   vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
 *   vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
 *   vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
 *   vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
 *   vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
 *   useCliEndHarness();
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchReport, MigrationOptions } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

/** What a report write does: written whole (null), refused at once (EIO, nothing written), or half written, then refused. */
export type ReportFault = null | 'EIO' | 'half';
const fresh = () => ({
  opts: null as MigrationOptions | null, phase: 'live' as 'dry' | 'live', batches: 8, sent: [] as string[], liveEntered: false,
  crashAt: null as number | null, crash: (() => undefined) as () => void, throwAtEnd: null as string | null,
  poolGate: Promise.resolve() as Promise<void>, endedSeen: null as string | null, inFlightGate: Promise.resolve() as Promise<void>,
  /** The nth report body written (1 = the "running" placeholder, 2 = the first stop report, 3 = its rewrite, ...): its fault. */
  reportFault: (() => null) as (nth: number) => ReportFault, reportWrites: 0, halfDone: false,
  dir: '', err: [] as string[], exit: null as unknown as ReturnType<typeof vi.spyOn>, before: {} as Record<string, Function[]>,
});
export type H = ReturnType<typeof fresh>;
const g = globalThis as { __sageCliEnd?: H };
export const h: H = (g.__sageCliEnd ??= fresh());

const batch = (entity: BatchReport['entity'], n: number): BatchReport => ({ entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { outcome: 'created' }, error: null });
export const tick = () => new Promise((r) => setImmediate(r));

export function runnerMock() {
  return {
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
  };
}
export const summaryMock = () => ({ CONSOLE_ERROR_CHARS: 600, summaryLines: () => ['SUMMARY LINE'], exitCodeFor: () => 0 });
export const pgMock = () => ({ default: { Pool: class { on() { return this; } async end() { await h.poolGate; } } } });

export const stall = (on: boolean, stream: 'stdout' | 'stderr' = 'stderr') => { (globalThis as { __sageConsoleStall?: unknown }).__sageConsoleStall = { [stream]: on }; };
const HOOKS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
export function useCliEndHarness(): void {
  beforeEach(() => {
    Object.assign(h, fresh(), { dir: mkdtempSync(join(tmpdir(), 'sage-cli-end-')) });
    process.exitCode = undefined;
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
    for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) vi.stubEnv(name, '');
    h.exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { h.err.push(String(s)); return true; });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    h.before = Object.fromEntries(HOOKS.map((e) => [e, process.listeners(e as NodeJS.Signals)]));
    stall(true);
  });
  afterEach(() => { stall(false); process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); if (h.dir !== '') rmSync(h.dir, { recursive: true, force: true }); });
}

/** What the CLI said on stderr so far. */
export const said = (): string => h.err.join('');
export const fire = (ev: (typeof HOOKS)[number], arg: unknown = ev) => { for (const l of process.listeners(ev as NodeJS.Signals).filter((x) => !h.before[ev]!.includes(x))) (l as (a: unknown) => void)(arg); };
export const reportText = () => readFileSync(join(h.dir, 'r.json'), 'utf8');
export const report = () => JSON.parse(reportText());
export async function start() {
  const argv = process.argv;
  process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', '00000000-0000-4000-8000-000000000001', '--user', '00000000-0000-4000-8000-000000000002',
    '--file', 'tests/fixtures/sage-export/sage-export.json', '--report', join(h.dir, 'r.json'), '--live', '--expect-items', '20', '--expect-pos', '10'];
  const { runCli } = await import('../../../../scripts/sage-migration/run');
  return { done: runCli({ removeHandlers: true }).finally(() => { process.argv = argv; }) };
}
/** Until the runner stopped asking (it threw or returned), at most 2 s. */
export const settle = async () => {
  await vi.waitFor(() => expect(h.opts).not.toBeNull(), { timeout: 10_000 }); // run.ts imports its body (runMain.ts) first
  for (let i = 0; i < 200 && h.exit.mock.calls.length === 0; i++) await tick();
  for (let i = 0; i < 20; i++) await tick();
};
/** A crash (an uncaught error) while live batch 3 is in flight; that batch answers only when `open()` is called. */
export function crashInFlight(): { open: () => void } {
  let open: () => void = () => undefined;
  h.inFlightGate = new Promise((r) => { open = r; });
  h.crashAt = 3;
  h.crash = () => fire('uncaughtException', new Error('injected'));
  return { open: () => open() };
}
