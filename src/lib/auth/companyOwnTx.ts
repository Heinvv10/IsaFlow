/**
 * An app_user transaction that COMMITS ON ITS OWN, beside the request's (the company-route sibling of
 * platformAdminOwnTx.ts).
 *
 * For a record that must be durable as soon as an outside effect has happened, whatever the request does later:
 * a payslip email that left (wave 6 PE, review #1542 S3). withAuth commits only after the handler returns and rolls
 * back on any 5xx, so a row written in the request could be erased after the mail already left, and the next click
 * would mail it again.
 *
 * Only from inside a company request: the claims and the company are the REQUEST CONTEXT's, never the caller's, and
 * with no company context it throws. It runs outside that context (`als.exit`) on a ONE-OFF connection built from
 * the request pool's own `authConnection()` (same URL, same login), never a second one from the auth pool the
 * request already holds a connection of (that deadlocks once the pool is exhausted, R-032). The connection takes the same shape withAuth gives its own: `SET LOCAL ROLE
 * app_user`, `request.jwt.claims` and `app.current_company_id`, so RLS and every stamp trigger apply as in the
 * request. `fn` runs in a fresh owned context bound to that connection, so `sql` and `logAuditOrThrow` inside it join
 * this transaction. lock_timeout is 5 s. It cannot see rows the request has not committed: use it only for writes
 * that need none. The connection is ended on every path, and a socket error on it is logged, never thrown.
 */
import pg, { type PoolClient } from 'pg';
import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { rollbackError } from '@/lib/rollbackFailed';
import { authConnection } from './authPool';

export async function withOwnCompanyTx<T>(fn: () => Promise<T>): Promise<T> {
  const request = als.getStore();
  if (!request?.companyId) throw new Error('withOwnCompanyTx: no company request context');
  const { userId, claims, companyId } = request;
  const connection = authConnection(); // the request pool's own URL and login (review #1542 D-I2), not the service pool's
  return als.exit(async () => {
    const client = new pg.Client({ ...connection, connectionTimeoutMillis: 5000 });
    client.on('error', (err: Error) => {
      log.error('withOwnCompanyTx: connection error', { message: err.message }, 'Auth');
    });
    let began = false;
    try {
      await client.connect();
      await client.query('BEGIN');
      began = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      const ctx: RequestContext = { client: client as unknown as PoolClient, userId, companyId, claims, afterCommit: [] };
      const result = await runOwnedContext(ctx, fn);
      if (ctx.rollbackOnly || ctx.txUnusable) {
        throw new Error(`withOwnCompanyTx: not committed (${ctx.rollbackOnly ?? ctx.txUnusable})`);
      }
      await client.query('COMMIT');
      drainAfterCommit(ctx);
      return result;
    } catch (err) {
      if (began) await rollbackError(client, 'withOwnCompanyTx');
      throw err;
    } finally {
      await client.end().catch((endErr: unknown) => {
        log.warn('withOwnCompanyTx: client end failed', { message: endErr instanceof Error ? endErr.message : String(endErr) }, 'Auth');
      });
    }
  });
}
