/**
 * R29-1 (B29-1), R29-2, R29-9, B29-4, B30-2 on run.ts / runEnd.ts, through sageCliEndHarness.ts (a mocked runner; the console's stderr
 * STALLED, so every exit has to wait for it). The waits after an end (the batch in flight, the ceiling): sageCliEndWait.test.ts.
 *   - an uncaught error / an unhandled rejection in the live phase ends the run: no batch is sent after it, the batch in flight settles
 *     and is said as such, and the books (what the runner sent), the report and the console agree; no summary, no exit code from main;
 *   - the same in the dry phase: the live phase never starts, exit 2;
 *   - a stray error while the exit waits changes nothing (R29-2); a first signal then says the run has already stopped (B29-4) and a
 *     second one exits at once, the code unchanged; after a finished run a second signal exits at once (R29-9).
 */
import { describe, expect, it, vi } from 'vitest';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import { fire, h, report, said, settle, stall, start, tick, useCliEndHarness } from './sageCliEndHarness';

vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
useCliEndHarness();

describe('R29-1: an end at once while the console is still being written stops the run for real', () => {
  for (const [what, ev] of [['an uncaught error', 'uncaughtException'], ['an unhandled rejection', 'unhandledRejection']] as const) {
    it(`live, ${what}: no batch after it; the one in flight settles and is said; books = report = console; no summary, exit 4 once drained`, async () => {
      h.crashAt = 3;
      h.crash = () => fire(ev, new Error('injected'));
      const { done } = await start();
      await settle();
      expect(h.sent).toEqual(['live 1', 'live 2', 'live 3']); // never batch 4 (shouldStop answered)
      expect(h.endedSeen).toMatch(/ended the run: injected/); // and the runner's sessions would refuse (MigrationOptions.ended)
      expect(h.exit).not.toHaveBeenCalled(); // the stop message still waits for its reader
      const r = report();
      expect(r).toMatchObject({ status: 'stopped', liveStarted: true });
      expect(r.committed.map((b: BatchReport) => b.n)).toEqual([1, 2, 3]); // batch 3 settled after the end: written into the report as it settled
      expect(r.commitUnconfirmed).toEqual([]);
      stall(false);
      await done;
      expect(h.exit.mock.calls).toEqual([[4]]);
      const out = said();
      expect(out).toMatch(/sage migration stopped: an (uncaught error|unhandled rejection) ended the run: injected/);
      expect(out).toMatch(/committed: category batch 1 .*\n.*committed: category batch 2 /s);
      expect(out).toMatch(/commit unconfirmed: category batch 3 /); // as known at the end...
      expect(out).toContain('the batch in flight when the run ended, category batch 3 (k-category-3), then committed; no batch followed it: the report says so'); // ...then as it settled
      expect(out).not.toMatch(/SUMMARY LINE|the run finished|report was not written/);
      expect(out).not.toMatch(/the run had ended \(/); // the runner's own stop that followed says nothing
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
    expect(h.exit.mock.calls).toEqual([[2]]);
    expect(said()).toContain('nothing was written to the books (the live phase had not started)');
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
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect(said()).not.toMatch(/SUMMARY LINE|the run finished|report was not written/);
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
    expect(h.exit).not.toHaveBeenCalled(); // R29-2: never cuts the stop message
    fire('SIGINT');
    for (let i = 0; i < 20; i++) await tick();
    expect(h.exit).not.toHaveBeenCalled();
    fire('SIGINT');
    expect(h.exit.mock.calls).toEqual([[2]]); // at once, the stop's own code
    stall(false);
    await done;
    expect(said()).toContain('SIGINT: the run has already stopped; its stop message is still being written (send it again to exit at once)');
    expect(said()).not.toMatch(/stops before its next batch/);
  });
  it('R29-9: after a finished run, a second signal exits at once', async () => {
    h.batches = 1;
    let open: () => void = () => undefined;
    h.poolGate = new Promise((r) => { open = r; }); // the run has finished; its pool is still closing: the handlers are still there
    const { done } = await start();
    await settle();
    fire('SIGTERM'); // the run had finished: said (queued behind the stalled reader)
    expect(h.exit).not.toHaveBeenCalled();
    fire('SIGTERM');
    expect(h.exit).toHaveBeenCalledTimes(1);
    stall(false);
    open();
    await done;
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
    expect(h.exit.mock.calls).toEqual([[4]]); // stderr is stalled: still at once
    expect(report().commitUnconfirmed.map((b: BatchReport) => b.n)).toEqual([3]);
    stall(false);
    open();
    await done;
  });
});

