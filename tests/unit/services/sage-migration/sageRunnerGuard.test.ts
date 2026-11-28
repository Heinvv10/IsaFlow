/** runSageMigration guards itself: a pool or an environment that is not a local throwaway database stops it before it connects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';

const LOCAL = 'postgresql://postgres@127.0.0.1:5433/isaflow_test';
const opts = { companyId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', live: true, expect: { items: 0, purchaseOrders: 0 } };
const file = () => parseSageExport({ Items: [] });
const pool = (connectionString: string | undefined) => {
  const connect = vi.fn(async () => { throw new Error('connected'); });
  return { p: { options: { connectionString }, connect } as never, connect };
};

afterEach(() => vi.unstubAllEnvs());

describe('runSageMigration refuses before it connects', () => {
  it('a pool aimed at the dev server, however clean the environment', async () => {
    vi.stubEnv('DATABASE_URL', LOCAL);
    const { p, connect } = pool('postgresql://postgres@127.0.0.1:7772/isaflow_dev');
    await expect(runSageMigration(p, file(), opts)).rejects.toThrow(/Refusing to run the Sage migration: the database pool/);
    expect(connect).not.toHaveBeenCalled();
  });
  it('a local pool in an environment whose DATABASE_URL (or service URL) is not local', async () => {
    const { p, connect } = pool(LOCAL);
    vi.stubEnv('DATABASE_URL', 'postgresql://postgres@127.0.0.1:7772/isaflow_dev');
    await expect(runSageMigration(p, file(), opts)).rejects.toThrow(/DATABASE_URL/);
    vi.stubEnv('DATABASE_URL', LOCAL);
    vi.stubEnv('SERVICE_DATABASE_URL', 'postgresql://svc@100.96.203.105:7772/isaflow');
    await expect(runSageMigration(p, file(), opts)).rejects.toThrow(/SERVICE_DATABASE_URL/);
    expect(connect).not.toHaveBeenCalled();
  });
  it('B5-G (round 5): a pool of one connection is refused at the start: the run lock would take it and the tool session wait forever', async () => {
    vi.stubEnv('DATABASE_URL', LOCAL);
    const connect = vi.fn(async () => { throw new Error('connected'); });
    await expect(runSageMigration({ options: { connectionString: LOCAL, max: 1 }, connect } as never, file(), opts)).rejects.toThrow(/at least 2 connections/);
    expect(connect).not.toHaveBeenCalled();
    await expect(runSageMigration({ options: { connectionString: LOCAL, max: 2 }, connect } as never, file(), opts)).rejects.toThrow('connected');
  });
  it('a local pool and a local environment get as far as connecting', async () => {
    vi.stubEnv('DATABASE_URL', LOCAL);
    vi.stubEnv('SERVICE_DATABASE_URL', '');
    const { p, connect } = pool(LOCAL);
    await expect(runSageMigration(p, file(), opts)).rejects.toThrow('connected');
    expect(connect).toHaveBeenCalled();
  });
});

describe('liveWithoutCounts is for tests and programmatic callers only', () => {
  // That the CLI never sets it is checked by what the CLI DOES (L7, round 10): tests/integration/sage-migration-cli.int.test.ts, "F4 / L7":
  // --live without --expect-items / --expect-pos is exit 2 and writes nothing.
  it('without the opt-out a live run with no counts throws before it connects; with it, it goes ahead (the runner is the only place that decides)', async () => {
    vi.stubEnv('DATABASE_URL', LOCAL);
    const { p, connect } = pool(LOCAL);
    const base = { companyId: opts.companyId, userId: opts.userId, live: true };
    await expect(runSageMigration(p, file(), base)).rejects.toThrow(/live run needs expect\.items and expect\.purchaseOrders/);
    expect(connect).not.toHaveBeenCalled();
    await expect(runSageMigration(p, file(), { ...base, liveWithoutCounts: true })).rejects.toThrow('connected');
  });
});
