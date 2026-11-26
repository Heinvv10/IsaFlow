/**
 * The waits after an end, on run.ts / runEnd.ts through sageCliEndHarness.ts (a mocked runner; split from sageCliEnd.test.ts):
 *   - R30-1: a crash waits, bounded, for the batch in flight, whatever the console does; B31-3: a first signal then says what it waits
 *     for, a second ends the wait; L4: once the wait timed out, a late settle is neither said nor written;
 *   - B31-2 / R30-4: the rewrite of the stop report never leaves the file empty, and each line says what became of the report;
 *   - M2: a run that ends by itself gets the console's total ceiling (runMain's endConsole), armed once: a crash after it waits only what
 *     is left of it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import { crashInFlight, fire, h, report, reportText, said, settle, stall, start, useCliEndHarness } from './sageCliEndHarness';

vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
useCliEndHarness();

const SETTLED = 'the batch in flight when the run ended, category batch 3 (k-category-3), then committed; no batch followed it';
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

describe('R30-1 / B31-3 / L4: a crash waits for the batch in flight, whatever the console does', () => {
  it('a HEALTHY console: the batch in flight settles first, is said and written into the report, then exit 4', async () => {
    stall(false);
    const { open } = crashInFlight();
    const { done } = await start();
    await settle();
    expect(h.exit).not.toHaveBeenCalled(); // the console is written, the batch is still in flight: it waits for that
    open();
    await done;
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect(h.sent).toEqual(['live 1', 'live 2', 'live 3']);
    expect(report().committed.map((b: BatchReport) => b.n)).toEqual([1, 2, 3]);
    expect(said()).toContain(`${SETTLED}: the report says so`);
  });
  it('B31-3: a first signal says it waits for the batch in flight and does not end the wait; the batch then settles, exit 4', async () => {
    stall(false);
    const { open } = crashInFlight();
    const { done } = await start();
    await settle();
    fire('SIGINT');
    expect(said()).toMatch(/SIGINT: the run has already stopped; it waits up to (79|80) s more for the batch in flight to settle \(send it again to exit at once: that batch then stays commit unconfirmed\)/);
    expect(said()).not.toContain('its stop message is still being written');
    open();
    await done;
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect(report().committed.map((b: BatchReport) => b.n)).toEqual([1, 2, 3]);
  });
  it('a second signal during that wait ends it at once (the report keeps the batch as commit unconfirmed)', async () => {
    stall(false);
    const { open } = crashInFlight();
    const { done } = await start();
    await settle();
    fire('SIGINT');
    expect(h.exit).not.toHaveBeenCalled();
    fire('SIGINT');
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
    open();
    await done;
  });
  it('bounded: a batch in flight that never settles is waited for at most IN_FLIGHT_WAIT_MS, said, then exit 4', async () => {
    stall(false);
    fakeTimers();
    try {
      const { open } = crashInFlight();
      const { done } = await start();
      await settle();
      const { IN_FLIGHT_WAIT_MS } = await import('../../../../scripts/sage-migration/runEnd');
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS - 1_000);
      expect(h.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.exit.mock.calls).toEqual([[4]]);
      expect(said()).toContain(`the batch in flight when the run ended, category batch 3 (k-category-3), did not settle within ${IN_FLIGHT_WAIT_MS / 1000} s: it stays commit unconfirmed: check the books`);
      expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
      open();
      await done;
    } finally { vi.useRealTimers(); }
  });
  it('L4: once the batch settled, the wait\'s timeout is gone: it never says "did not settle" afterwards', async () => {
    stall(false);
    fakeTimers();
    try {
      const { open } = crashInFlight();
      const { done } = await start();
      await settle();
      open();
      await done;
      const { IN_FLIGHT_WAIT_MS } = await import('../../../../scripts/sage-migration/runEnd');
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS);
      expect(said()).toContain(`${SETTLED}: the report says so`);
      expect(said()).not.toContain('did not settle');
    } finally { vi.useRealTimers(); }
  });
  it('L4: a settle that comes as the wait times out is neither said nor written (the report is being closed)', async () => {
    stall(false);
    fakeTimers();
    try {
      crashInFlight();
      const { done } = await start();
      await settle();
      const { IN_FLIGHT_WAIT_MS, cli } = await import('../../../../scripts/sage-migration/runEnd');
      const late: BatchReport = { entity: 'category', n: 3, size: 1, key: 'k-category-3', status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { outcome: 'created' }, error: null };
      vi.mocked(process.stderr.write).mockImplementation((s) => { // the settle lands inside the timeout's own turn
        h.err.push(String(s));
        if (String(s).includes('did not settle within')) cli.state.onSettledAfterEnd?.(late);
        return true;
      });
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS);
      expect(h.exit.mock.calls).toEqual([[4]]);
      expect(said()).not.toContain(SETTLED);
      expect(said()).not.toContain('the file is closed');
      expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
      void done;
    } finally { vi.useRealTimers(); }
  });
});

describe('B31-2 / R30-4: the rewrite of the stop report, on a failing disk', () => {
  // The nth report body: 1 the "running" placeholder, 2 the first stop report, 3 its rewrite once batch 3 settled, 4 and 5 what follows.
  const run = async (fault: (nth: number) => null | 'EIO' | 'half') => {
    stall(false);
    h.reportFault = fault;
    crashInFlight().open();
    const { done } = await start();
    await settle();
    await done;
    expect(h.exit.mock.calls).toEqual([[4]]);
  };
  const first = () => {
    const r = report();
    expect(r.status).toBe('stopped');
    expect(r.committed.map((b: BatchReport) => b.n)).toEqual([1, 2]); // the first report, with batch 3 still in flight
    expect(r.commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
  };
  it('the rewrite refused before its first byte: the first report is untouched, and kept; "the report says so" is not said', async () => {
    await run((n) => (n === 3 ? 'EIO' : null));
    first();
    expect(said()).toContain(`${SETTLED}\n`);
    expect(said()).not.toContain('the report says so');
    expect(said()).toMatch(/could not be written: EIO: injected: the stop report written before is kept \(it lists that batch commit unconfirmed\)/);
  });
  it('every write from the rewrite on refused: the first report is still whole (never truncated to 0 bytes first)', async () => {
    await run((n) => (n >= 3 ? 'EIO' : null));
    expect(reportText().length).toBeGreaterThan(0);
    first();
    expect(said()).toContain('the stop report written before is kept');
  });
  it('the rewrite refused half-way: the first report is written back, and that is said', async () => {
    await run((n) => (n === 3 ? 'half' : null));
    first();
    expect(said()).toMatch(/could not be written: EIO: injected: the stop report written before was written back \(it lists that batch commit unconfirmed\)/);
    expect(said()).not.toContain('is kept');
  });
  it('the rewrite refused half-way and every write after it: nothing claims a report is kept', async () => {
    await run((n) => (n === 3 ? 'half' : n > 3 ? 'EIO' : null));
    expect(said()).not.toMatch(/is kept|written back|the report says so/);
    expect(said()).toMatch(/r\.json may hold neither stop report now \(a failing disk\): the lines above are the run's report/);
  });
});

describe('M2: a run that ends by itself gets the console\'s total ceiling, armed once', () => {
  it('stdout stalled, the run finishes: past CONSOLE_EXIT_CEILING_MS stdout is given up and nothing holds the process; no exit forced', async () => {
    fakeTimers();
    try {
      stall(true, 'stdout'); // its summary waits for a reader
      h.batches = 2;
      const { done } = await start();
      await settle();
      await done; // the run ended by itself: runCli has returned
      const { CONSOLE_EXIT_CEILING_MS, cliConsole } = await import('../../../../scripts/sage-migration/runConsole');
      expect(cliConsole.queuedBytes('stdout')).toBeGreaterThan(0); // the summary still waits for the reader
      await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS - 1_000);
      expect(cliConsole.gone.stdout).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cliConsole.gone).toEqual({ stdout: true, stderr: false });
      expect(said()).toContain('stdout: the exit waited 120 s for its reader'); // said on stderr
      expect(cliConsole.idle()).toBe(true);
      expect(vi.getTimerCount()).toBe(0); // no retry left: the process ends by itself
      expect(h.exit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('an uncaught error 100 s after that natural end exits at the same ceiling (120 s from the end), not 120 s after the error', async () => {
    fakeTimers();
    try {
      stall(true, 'stdout');
      h.batches = 2;
      const { done } = await start();
      await settle();
      await done;
      const { CONSOLE_EXIT_CEILING_MS } = await import('../../../../scripts/sage-migration/runConsole');
      const { terminate } = await import('../../../../scripts/sage-migration/runEnd');
      await vi.advanceTimersByTimeAsync(100_000);
      terminate('an uncaught error ended the run: late', false); // what the uncaughtException handler calls
      await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS - 100_000);
      expect(h.exit.mock.calls).toEqual([[]]); // process.exit(): the finished run's exit code stands
    } finally { vi.useRealTimers(); }
  });
});
