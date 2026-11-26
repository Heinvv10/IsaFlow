/**
 * Round-11 review R1: what scripts/sage-migration/run.ts hands the runner. run.ts is run with --live and both counts against a MOCKED
 * runner (nothing connects), and the options it passed are read back: liveWithoutCounts is never among them, and the counts are the flags.
 * (That --live WITHOUT the counts is exit 2 with nothing written is the CLI suite's "F4 / L7": run.ts refuses before the runner runs.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MigrationOptions } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));

const seen = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock('@/modules/accounting/services/sage-migration/sageMigrationRunner', () => ({
  runSageMigration: vi.fn(async (_pool: unknown, _parsed: unknown, o: unknown) => { seen.opts.push(o); throw new Error('mocked runner: stop here'); }),
}));

const COMPANY = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); seen.opts.length = 0; });

describe('R1: run.ts never passes liveWithoutCounts', () => {
  it('--live with --expect-items and --expect-pos: the runner gets the two counts and no liveWithoutCounts', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:5433/isaflow_test');
    for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL', 'DIRECT_DATABASE_URL', 'DATABASE_URL_UNPOOLED']) vi.stubEnv(name, '');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const argv = process.argv;
    process.argv = [argv[0]!, 'scripts/sage-migration/run.ts', '--company', COMPANY, '--user', USER, '--file', 'tests/fixtures/sage-export/sage-export.json',
      '--live', '--expect-items', '20', '--expect-pos', '10', '--expect-po-total', '1.00'];
    try {
      const { runCli } = await import('../../../../scripts/sage-migration/run');
      await runCli({ removeHandlers: true });
      expect(exit).toHaveBeenCalled();
    } finally { process.argv = argv; }
    expect(seen.opts).toHaveLength(1);
    const o = seen.opts[0] as MigrationOptions;
    expect(o).toMatchObject({ companyId: COMPANY, userId: USER, live: true, expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: 100 } });
    expect('liveWithoutCounts' in o).toBe(false);
    expect(exit).toHaveBeenCalledWith(2); // the mocked runner's error: a refused start (not a MigrationStopped)
  });
});
