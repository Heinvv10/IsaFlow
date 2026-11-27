/**
 * What the CLI says of its --report when the console is cut or a write fails (round 33), through sageCliEndHarness.ts:
 *   - B33-1: the second-signal cut notice and the ceiling notice name the file as holding the run's report only when it does; otherwise
 *     what it holds (the placeholder, the note, a mix) and that no report of the run was written;
 *   - L3: a stop report and note both refused end with a line naming what the file still holds;
 *   - L2: a refused ftruncate whose fstat also fails reports the ftruncate's error; L4: a timeout callback that throws is logged.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReportFault } from './sageCliEndHarness';
import { crashInFlight, fire, h, printed, said, settle, stall, start, useCliEndHarness } from './sageCliEndHarness';

vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
useCliEndHarness();

const NONE = 'no report of this run was written: check the books';
// 1 the placeholder, 2 the stop report, 3 the note when 2 was not written.
const cases: Array<[string, (n: number) => ReportFault, RegExp]> = [
  ['the stop report written', () => null, /--report \S+r\.json holds the run's report/],
  ['stop report and note refused: the placeholder', (n) => (n >= 2 ? 'EIO' : null), new RegExp(`r\\.json still holds only the "running" placeholder: ${NONE}`)],
  ['stop report refused, the note written', (n) => (n === 2 ? 'EIO' : null), new RegExp(`r\\.json holds only a "stop_report_not_written" note: ${NONE}`)],
  ['stop report torn, the note refused: a mix', (n) => (n === 2 ? 'half' : n > 2 ? 'EIO' : null), new RegExp(`r\\.json may hold neither stop report now \\(a failing disk\\): ${NONE}`)],
];

describe('B33-1: the second signal\'s cut notice names what the file holds', () => {
  for (const [what, fault, line] of cases) {
    it(what, async () => {
      h.reportFault = fault;
      h.inFlightGate = new Promise(() => undefined); // batch 3 never answers: the second signal ends the run at once
      h.crashAt = 3;
      h.crash = () => { fire('SIGINT'); fire('SIGINT'); };
      const { done } = await start();
      await settle();
      expect(h.exit.mock.calls).toEqual([[4]]); // stderr is stalled: its stop message is cut, said on stdout
      expect(printed()).toMatch(/stderr: \d+ bytes of what it was given were not written: a second signal ended the run at once; /);
      expect(printed()).toMatch(line);
      void done;
    });
  }
});

describe('B33-1: the ceiling notice too', () => {
  it('stop report and note refused, stderr stalled past the ceiling: the notice says no report was written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.reportFault = (n) => (n >= 2 ? 'EIO' : null);
      h.throwAtEnd = 'the books refused it';
      const { done } = await start();
      await settle();
      const { CONSOLE_EXIT_CEILING_MS } = await import('../../../../scripts/sage-migration/runConsole');
      await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
      await done;
      expect(printed()).toMatch(new RegExp(`stderr: the exit waited 120 s for its reader: .*r\\.json still holds only the "running" placeholder: ${NONE}`));
      expect(printed()).not.toContain("holds the run's report");
    } finally { vi.useRealTimers(); }
  });
});

describe('B33-1: OwnedReport.hintLine follows what was written whole', () => {
  it('nothing tried yet: where the report is written; a stop report written: it holds it; a later refusal that changed nothing: still', async () => {
    const { OwnedReport } = await import('../../../../scripts/sage-migration/runReport');
    const owned = OwnedReport.create(`${h.dir}/x.json`);
    if (!('hintLine' in owned)) throw new Error(`not created: ${owned.why}`);
    expect(owned.hintLine()).toBe(`--report ${h.dir}/x.json is where the run's report is written when it ends`);
    expect(owned.write({ status: 'stopped' })).toBeNull();
    expect(owned.hintLine()).toBe(`--report ${h.dir}/x.json holds the run's report`);
    h.reportFault = () => 'EIO';
    expect(owned.write({ status: 'stopped', more: 1 })).not.toBeNull();
    expect(owned.hintLine()).toBe(`--report ${h.dir}/x.json holds the run's report`); // the first is still there, whole
    owned.close();
  });
  it('the placeholder after a refused write: no report of this run was written', async () => {
    const { OwnedReport } = await import('../../../../scripts/sage-migration/runReport');
    const owned = OwnedReport.create(`${h.dir}/y.json`);
    if (!('hintLine' in owned)) throw new Error(`not created: ${owned.why}`);
    h.reportFault = () => 'EIO';
    expect(owned.write({ status: 'stopped' })).not.toBeNull();
    expect(owned.hintLine()).toBe(`--report ${h.dir}/y.json still holds only the "running" placeholder: no report of this run was written: check the books`);
    owned.close();
  });
});

describe('L3 / L2 / L4: the report\'s own lines', () => {
  it('L3: the stop report and the note both refused: a closing line names the placeholder the file still holds', async () => {
    stall(false);
    h.reportFault = (n) => (n >= 2 ? 'EIO' : null);
    h.throwAtEnd = 'the books refused it';
    const { done } = await start();
    await settle();
    await done;
    expect(said()).toMatch(/r\.json still holds only the "running" placeholder: the lines above are the run's report/);
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
