/**
 * A request transaction opened the way withAuth opens one (src/lib/auth/withAuth.ts): `SET LOCAL ROLE app_user`, the
 * member's claims and the active company as transaction-local settings, so RLS and the table grants apply. The fixture
 * user must be a member of the company (seedRouteUser) or the tenant policies show it nothing.
 */
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import type { Fixture } from './l1FifoFixture';

/** BEGIN as app_user; the caller commits or rolls back and releases. */
export async function openAppUserTx(fx: Fixture): Promise<PoolClient> {
  const client = await fx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.userId })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [fx.companyId]);
    return client;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw err;
  }
}

/** `fn` bound to an open client, as every service expects. */
export function runAsAppUser<T>(fx: Fixture, client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: fx.userId, companyId: fx.companyId, claims: { sub: fx.userId } } as never, fn);
}

/** One whole request as app_user: committed on success, rolled back on a throw. */
export async function inAppUserTx<T>(fx: Fixture, fn: () => Promise<T>): Promise<T> {
  const client = await openAppUserTx(fx);
  try {
    const out = await runAsAppUser(fx, client, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
