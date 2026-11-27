/**
 * What the CLI says of its --report when the console is cut or a write fails (round 33), through sageCliEndHarness.ts:
 *   - B33-1 / round 34: OwnedReport.finalWord, the console's final word (every end, every stream: sageCliEndFinal.test.ts);
 *   - L3: a stop report and note both refused end with the final word naming what the file still holds;
 *   - L2: a refused ftruncate whose fstat also fails reports the ftruncate's error; L4: a timeout callback that throws is logged.
 */
import { describe, expect, it, vi } from 'vitest';
import { crashInFlight, fire, h, report, said, settle, stall, start, useCliEndHarness } from './sageCliEndHarness';

vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
useCliEndHarness();

const NONE = 'no report of this run was written: check the books';

describe('B33-1 / round 34: OwnedReport.finalWord follows what was written whole', () => {
  it('nothing written yet: the placeholder; a stop report written: it holds it; a later refusal that changed nothing: still', async () => {
    const { OwnedReport } = await import('../../../../scripts/sage-migration/runReport');
    const owned = OwnedReport.create(`${h.dir}/x.json`);
    if (!('finalWord' in owned)) throw new Error(`not created: ${owned.why}`);
    expect(owned.finalWord()).toBe(`--report ${h.dir}/x.json still holds only the "running" placeholder: ${NONE}`);
    expect(owned.write({ status: 'stopped' })).toBeNull();
    expect(owned.finalWord()).toBe(`--report ${h.dir}/x.json holds the run's report`);
    h.reportFault = () => 'EIO';
    expect(owned.write({ status: 'stopped', more: 1 })).not.toBeNull();
    expect(owned.finalWord()).toBe(`--report ${h.dir}/x.json holds the run's report`); // the first is still there, whole
    owned.close();
  });
  it('the placeholder after a refused write: no report of this run was written', async () => {
    const { OwnedReport } = await import('../../../../scripts/sage-migration/runReport');
    const owned = OwnedReport.create(`${h.dir}/y.json`);
    if (!('finalWord' in owned)) throw new Error(`not created: ${owned.why}`);
    h.reportFault = () => 'EIO';
    expect(owned.write({ status: 'stopped' })).not.toBeNull();
    expect(owned.finalWord()).toBe(`--report ${h.dir}/y.json still holds only the "running" placeholder: no report of this run was written: check the books`);
    owned.close();
  });
});

describe('L3 / L2 / L4: the report\'s own lines', () => {
  it('L3: the stop report and the note both refused: the last line (the final word) names the placeholder the file still holds', async () => {
    stall(false);
    h.reportFault = (n) => (n >= 2 ? 'EIO' : null);
    h.throwAtEnd = 'the books refused it';
    const { done } = await start();
    await settle();
    await done;
    expect(said().trimEnd().split('\n').at(-1)).toMatch(new RegExp(`r\\.json still holds only the "running" placeholder: ${NONE}$`)); // the final word, last
  });
  it('L2: a refused ftruncate whose fstat fails too reports the ftruncate\'s error, never the fstat\'s', async () => {
    stall(false);
    h.throwAtEnd = 'the books refused it';
    h.truncFault = (n) => n === 2;
    h.fstatFault = true;
    const { done } = await start();
    await settle();
    await done;
    expect(said()).toContain('could not be written: EIO: injected ftruncate');
    expect(said()).not.toContain('injected fstat');
  });
  it('L4: a timeout that throws is logged, and the exit follows', async () => {
    stall(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      crashInFlight();
      const { done } = await start();
      await settle();
      const { IN_FLIGHT_WAIT_MS, cli } = await import('../../../../scripts/sage-migration/runEnd');
      cli.owned!.close = () => { throw new Error('a close that throws'); };
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS);
      expect(h.exit.mock.calls).toEqual([[4]]);
      expect([...h.err, ...logged.mock.calls.map(String)].join('')).toContain('the wait for the batch in flight timed out, but saying or closing it failed');
      void done;
    } finally { vi.useRealTimers(); }
  });
});

describe('B35-2: a hostile thrown value is told, never thrown from a handler', () => {
  const hostile = () => ({ toString: () => { throw new Error('hostile toString'); } });
  it('an uncaught hostile throw during the live phase: the run stops properly, exit 4 and a stop report', async () => {
    stall(false);
    h.crashAt = 3;
    h.crash = () => fire('uncaughtException', hostile());
    const { done } = await start();
    await settle();
    await done;
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect(said()).toContain('sage migration stopped: an uncaught error ended the run: an error whose message cannot be read');
    expect(report()).toMatchObject({ status: 'stopped', liveStarted: true });
  });
  it('a pool end that rejects with a hostile value: said, and the clean run keeps exit 0 and its report', async () => {
    stall(false);
    h.batches = 1;
    h.poolGate = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(hostile()) } as unknown as Promise<void>;
    const { done } = await start();
    await settle();
    await done;
    expect(h.exit).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(said()).toContain('closing the database pool failed: an error whose message cannot be read');
    expect(said()).not.toContain('sage migration stopped');
    expect(report().status).toBe('dry_run_ok');
  });
});

