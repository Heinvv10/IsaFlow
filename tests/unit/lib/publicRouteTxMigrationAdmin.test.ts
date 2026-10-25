/**
 * S-07e: withPublicRouteTransaction(..., { migrationAdmin: true }) (the Paystack
 * webhook) opens a migration_admin transaction beside its own only when a
 * migrationAdminTx inside asks for one, joins every later one in a savepoint,
 * and on success COMMITs migration_admin first. If the service pool's COMMIT
 * then fails, both are rolled back (the committed one harmlessly), both
 * connections are released, and the error reaches the caller, so the gateway
 * redelivers. Scripted clients stand in for both pools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const events: string[] = [];
  const make = (name: string, failOn?: () => string | undefined) => ({
    query: vi.fn(async (text: string) => {
      const verb = String(text).trim().split(/\s+/).slice(0, 2).join(' ');
      events.push(`${name}:${verb}`);
      if (failOn?.() && String(text).trim().startsWith(failOn()!)) throw new Error(`${name} ${failOn()} failed`);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn((destroy?: boolean) => { events.push(`${name}:release(${destroy ? 'destroy' : 'pool'})`); }),
  });
  const state = { serviceFail: undefined as string | undefined, adminConnects: 0 };
  const service = make('service', () => state.serviceFail);
  const admin = make('admin');
  return { events, service, admin, state };
});

vi.mock('@/lib/neon', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDbPool: () => ({ connect: async () => h.service }),
}));
vi.mock('pg', async (importOriginal) => {
  const real = await importOriginal<typeof import('pg')>();
  class Pool {
    on() { return this; }
    async connect() { h.state.adminConnects += 1; return h.admin; }
  }
  return { ...real, default: { ...real.default, Pool }, Pool };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';

beforeEach(() => {
  h.events.length = 0;
  h.state.serviceFail = undefined;
  h.state.adminConnects = 0;
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgresql://migration_admin@127.0.0.1:1/x');
});

const event = () => withPublicRouteTransaction('test-webhook', async () => {
  await migrationAdminSqlTx('first', (tx) => tx`UPDATE flow_purchases SET status = 'succeeded'`);
  await migrationAdminSqlTx('second', (tx) => tx`UPDATE flow_wallet SET balance_flows = 1`);
}, { migrationAdmin: true });

describe('the webhook\'s migration_admin transaction', () => {
  it('is opened once, joined by each billing write in a savepoint, and COMMITs before the service pool', async () => {
    await event();
    expect(h.state.adminConnects).toBe(1);
    const commits = h.events.filter((e) => e.endsWith(':COMMIT'));
    expect(commits).toEqual(['admin:COMMIT', 'service:COMMIT']);
    expect(h.events.filter((e) => e.startsWith('admin:SAVEPOINT'))).toHaveLength(2);
    expect(h.events).toContain('admin:release(pool)');
    expect(h.events).toContain('service:release(pool)');
  });

  it('when the service pool\'s COMMIT fails after migration_admin\'s: both roll back, both are released, the error reaches the caller', async () => {
    h.state.serviceFail = 'COMMIT';
    await expect(event()).rejects.toThrow(/service COMMIT failed/);
    const i = h.events.indexOf('admin:COMMIT');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.events.slice(i)).toEqual(expect.arrayContaining(['service:ROLLBACK', 'admin:ROLLBACK']));
    expect(h.events.some((e) => e.startsWith('admin:release('))).toBe(true);
    expect(h.events.some((e) => e.startsWith('service:release('))).toBe(true);
  });

  it('takes no migration_admin connection for an event that writes no billing row', async () => {
    await withPublicRouteTransaction('test-webhook', async () => undefined, { migrationAdmin: true });
    expect(h.state.adminConnects).toBe(0);
    expect(h.events.filter((e) => e.startsWith('admin:'))).toEqual([]);
  });
});
