/**
 * A platform_admin transaction that COMMITS ON ITS OWN, beside the request's.
 *
 * For a step that must be durable before an outside effect happens, whatever the request does
 * later (the admin invoice Send: its claim before the email, its finalise after). The request's
 * withPlatformAdmin transaction commits only after the handler returns and rolls back on any 5xx,
 * so a write made there could be erased after the email already left.
 *
 * Only from inside a platform-admin request: the actor (userId) and the JWT claims are the REQUEST
 * CONTEXT's, never the caller's, and with no request context it throws. It runs outside that context
 * (`als.exit`) on a ONE-OFF connection (newPlatformAdminClient), never a second one from the pool the
 * request already holds a connection of (that deadlocks once the pool is exhausted, R-032). These
 * one-off connections are NOT counted by PLATFORM_ADMIN_POOL_MAX. `fn` runs in a fresh owned context
 * bound to that connection, so `sql`, `withSavepoint` and `logAdminAction` inside it join this
 * transaction. `lock_timeout` is 5 s; a failed critical audit write rolls it back, as
 * withPlatformAdmin does; `request.jwt.claims` is set as withPlatformAdmin sets it. The connection is
 * ended on every path, a failed connect included, and a socket error on it is logged, never thrown
 * as an uncaught 'error' event.
 */
import type { PoolClient } from 'pg';
import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { rollbackError } from '@/lib/rollbackFailed';
import { newPlatformAdminClient } from './withPlatformAdmin.pools';

export const OWN_TX_LOCK_TIMEOUT = '5s';

export async function withOwnPlatformAdminTx<T>(fn: () => Promise<T>): Promise<T> {
  const request = als.getStore();
  if (!request) throw new Error('withOwnPlatformAdminTx: no request context (platform-admin requests only)');
  const { userId, claims } = request;
  return als.exit(async () => {
    const client = newPlatformAdminClient();
    client.on('error', (err: Error) => {
      log.error('withOwnPlatformAdminTx: connection error', { message: err.message }, 'Auth');
    });
    let began = false;
    try {
      await client.connect();
      await client.query('BEGIN');
      began = true;
      await client.query(`SET LOCAL lock_timeout = '${OWN_TX_LOCK_TIMEOUT}'`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const ctx: RequestContext = { client: client as unknown as PoolClient, userId, claims, afterCommit: [] };
      const result = await runOwnedContext(ctx, fn);
      if (ctx.criticalAuditFailed || ctx.rollbackOnly || ctx.txUnusable) {
        throw new Error(`withOwnPlatformAdminTx: not committed (${ctx.criticalAuditFailed ? 'audit write failed' : ctx.rollbackOnly ?? ctx.txUnusable})`);
      }
      await client.query('COMMIT');
      drainAfterCommit(ctx);
      return result;
    } catch (err) {
      // The connection is ended below either way, so a failed ROLLBACK cannot leak its transaction.
      if (began) await rollbackError(client, 'withOwnPlatformAdminTx');
      throw err;
    } finally {
      await client.end().catch((endErr: unknown) => {
        log.warn('withOwnPlatformAdminTx: client end failed', { message: endErr instanceof Error ? endErr.message : String(endErr) }, 'Auth');
      });
    }
  });
}
