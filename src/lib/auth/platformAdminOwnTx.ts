/**
 * A platform_admin transaction that COMMITS ON ITS OWN, beside the request's.
 *
 * For a step that must be durable before an outside effect happens, whatever the request does
 * later (the admin invoice Send: its claim before the email, its finalise after). The request's
 * withPlatformAdmin transaction commits only after the handler returns and rolls back on any 5xx,
 * so a write made there could be erased after the email already left.
 *
 * It runs outside the request's ALS context (`als.exit`) on a ONE-OFF connection
 * (newPlatformAdminClient), never a second one from the pool the request already holds a
 * connection of (that deadlocks once the pool is exhausted, R-032). `fn` runs in a fresh owned
 * context bound to that connection, so `sql`, `withSavepoint` and `logAdminAction` inside it all
 * join this transaction. A failed critical audit write rolls it back, as withPlatformAdmin does.
 * `request.jwt.claims` is set as withPlatformAdmin sets it, so audit triggers see the actor.
 */
import type { PoolClient } from 'pg';
import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { rollbackError } from '@/lib/rollbackFailed';
import { newPlatformAdminClient } from './withPlatformAdmin.pools';

export async function withOwnPlatformAdminTx<T>(
  actor: { userId: string; claims: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  return als.exit(async () => {
    const client = newPlatformAdminClient();
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(actor.claims)]);
      const ctx: RequestContext = {
        client: client as unknown as PoolClient, userId: actor.userId, claims: actor.claims, afterCommit: [],
      };
      const result = await runOwnedContext(ctx, fn);
      if (ctx.criticalAuditFailed || ctx.rollbackOnly || ctx.txUnusable) {
        throw new Error(`withOwnPlatformAdminTx: not committed (${ctx.criticalAuditFailed ? 'audit write failed' : ctx.rollbackOnly ?? ctx.txUnusable})`);
      }
      await client.query('COMMIT');
      drainAfterCommit(ctx);
      return result;
    } catch (err) {
      // The connection is ended below either way, so a failed ROLLBACK cannot leak its transaction.
      await rollbackError(client, 'withOwnPlatformAdminTx');
      throw err;
    } finally {
      await client.end().catch((endErr: unknown) => {
        log.warn('withOwnPlatformAdminTx: client end failed', { message: endErr instanceof Error ? endErr.message : String(endErr) }, 'Auth');
      });
    }
  });
}
