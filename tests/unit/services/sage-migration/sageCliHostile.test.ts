/**
 * Round 36 at the CLI (sageCliEndHarness.ts): a hostile thrown value (hostileValues.ts) is told, never thrown again.
 *   - R36-1: thrown out of main() (the runner), it is stopped like a plain Error: the same exit code, a stop message and a stop report;
 *   - B36-3: a hostile pool 'error' is said and a clean run stays clean;
 *   - R36-5: thrown by the argument parser, the local-database guard or the export parser: a refused start, exit 2, said;
 *     the in-flight wait's L1 / L4 catches log it.
 */
import { describe, expect, it, vi } from 'vitest';
import { crashInFlight, h, report, said, settle, stall, start, useCliEndHarness } from './sageCliEndHarness';
import { hostileValues } from './hostileValues';

const g = globalThis as { __sageHostile?: { args?: () => unknown; guard?: () => unknown; parse?: () => unknown } };
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', async () => (await import('./sageCliEndHarness')).runnerMock());
vi.mock('@/modules/accounting/services/sage-migration/sageReportSummary', async () => (await import('./sageCliEndHarness')).summaryMock());
vi.mock('node:fs', async (orig) => (await import('./sageCliEndFsMock')).fsMock(await orig()));
vi.mock('pg', async () => (await import('./sageCliEndHarness')).pgMock());
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));
vi.mock('node:util', async (orig) => {
  const real = await orig<typeof import('node:util')>();
  const parseArgs = ((...a: Parameters<typeof real.parseArgs>) => { const t = (globalThis as typeof g).__sageHostile?.args; if (t) throw t(); return real.parseArgs(...a); }) as typeof real.parseArgs;
  return { ...real, default: { ...real, parseArgs }, parseArgs };
});
vi.mock('@/modules/accounting/services/sage-migration/localGuard', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/sage-migration/localGuard')>();
  return { ...real, assertLocalDatabase: () => { const t = (globalThis as typeof g).__sageHostile?.guard; if (t) throw t(); return real.assertLocalDatabase(); } };
});
vi.mock('@/modules/accounting/services/sage-migration/sageExportParser', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/sage-migration/sageExportParser')>();
  return { ...real, parseSageExport: (...a: Parameters<typeof real.parseSageExport>) => { const t = (globalThis as typeof g).__sageHostile?.parse; if (t) throw t(); return real.parseSageExport(...a); } };
});
useCliEndHarness();

const UNREADABLE = 'an error whose message cannot be read';
const runTo = async () => { const { done } = await start(); await settle(); await done; };

describe('R36-1: a hostile value thrown out of main() stops the run like a plain Error', () => {
  it('the control: a plain Error', async () => {
    stall(false);
    h.throwValue = () => new Error('injected: plain');
    await runTo();
    expect(h.exit.mock.calls).toEqual([[2]]);
  });
  for (const [what, make] of hostileValues) {
    it(`${what}: exit 2, the stop message, a stop report`, async () => {
      stall(false);
      h.throwValue = make;
      await runTo();
      expect(h.exit.mock.calls).toEqual([[2]]);
      expect(said()).toContain(`sage migration stopped: ${UNREADABLE}`);
      expect(report().status).toBe('stopped');
    });
  }
});

describe('B36-3: a hostile pool error', () => {
  for (const [what, make] of hostileValues) {
    it(`${what}: said, and the clean run keeps its exit and report`, async () => {
      stall(false);
      h.batches = 1;
      const { done } = await start();
      await settle();
      h.poolError?.(make());
      await done;
      expect(said()).toContain(`database pool error: ${UNREADABLE}`);
      expect(h.exit).not.toHaveBeenCalled();
      expect(report().status).toBe('dry_run_ok');
    });
  }
});

describe('R36-5: the refused-start reads, and the in-flight wait\'s catches', () => {
  const [what, make] = hostileValues[0]!;
  for (const site of ['args', 'guard', 'parse'] as const) {
    it(`${site} throws ${what}: a refused start, exit 2, told`, async () => {
      stall(false);
      g.__sageHostile = { [site]: make };
      try {
        const { done } = await start();
        await done;
        expect(h.exit.mock.calls).toEqual([[2]]);
        expect(said()).toContain(UNREADABLE);
      } finally { g.__sageHostile = undefined; }
    });
  }
  it('L1: the settle\'s rewrite throws a hostile value: logged, told, and the exit follows', async () => {
    stall(false);
    const { open } = crashInFlight();
    const { done } = await start();
    await settle();
    const { cli } = await import('../../../../scripts/sage-migration/runEnd');
    cli.owned!.write = () => { throw make(); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    open();
    await done;
    expect(h.exit.mock.calls).toEqual([[4]]);
    expect([...h.err, ...logged.mock.calls.map((c) => c.map(String).join(' '))].join('')).toContain(UNREADABLE);
  });
  it('L4: the timeout\'s close throws a hostile value: logged, told, and the exit follows', async () => {
    stall(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      crashInFlight();
      const { done } = await start();
      await settle();
      const { IN_FLIGHT_WAIT_MS, cli } = await import('../../../../scripts/sage-migration/runEnd');
      cli.owned!.close = () => { throw make(); };
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS);
      expect(h.exit.mock.calls).toEqual([[4]]);
      expect([...h.err, ...logged.mock.calls.map((c) => c.map(String).join(' '))].join('')).toContain(UNREADABLE);
      void done;
    } finally { vi.useRealTimers(); }
  });
});
