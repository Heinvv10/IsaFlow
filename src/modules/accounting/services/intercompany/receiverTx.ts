/**
 * A transaction opened AS THE RECEIVER (P2's auto-accept worker): app_user, the claims of one write-role user of the receiving
 * company and that company's GUCs, exactly as `withAuth` opens a request, so RLS and every guard of 1000 / 1002 apply as they would
 * to that user's own click. There is no other way a worker writes in a company's books: it never uses the sender's context and has
 * no user-less write path. It is bound to the ALS context like a request (`runOwnedContext`), so the receiver's own services
 * (`createSupplierInvoice`, `createCreditNote`) join this transaction.
 *
 * It opens on the request pool's login, not the service pool's (see below). lock_timeout 5 s and statement_timeout 60 s (never loosened). One message per transaction: one failure never takes the
 * others down, and a committed draft is never rolled back by a later message.
 */
import type { PoolClient } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { drainAfterCommit, runOwnedContext } from '@/lib/afterCommit';
import type { RequestContext } from '@/lib/als';
import { rollbackFailed } from '@/lib/rollbackFailed';

export interface ReceiverPrincipal {
  /** A write-role user of the receiving company, in good standing (from the queue). */
  userId: string;
  companyId: string;
}

export async function withReceiverTx<T>(p: ReceiverPrincipal, fn: () => Promise<T>): Promise<T> {
  // The REQUEST login (isaflow_app in production, the pool withAuth and withOwnCompanyTx open their transactions on), never the service
  // login: that one inherits app_service, whose policies are USING (true), so a RESET ROLE inside this transaction would read every tenant.
  // isaflow_app holds no table privilege of its own: a RESET ROLE leaves it with nothing. Only the queue below runs on the service login.
  const client: PoolClient = await getAuthPool().connect();
  let begun = false;
  let unusable = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: p.userId };
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    const ctx: RequestContext = { client, userId: p.userId, companyId: p.companyId, claims, afterCommit: [] };
    const out = await runOwnedContext(ctx, fn);
    if (ctx.rollbackOnly || ctx.txUnusable) throw new Error(`withReceiverTx: not committed (${ctx.rollbackOnly ?? ctx.txUnusable})`);
    await client.query('COMMIT');
    drainAfterCommit(ctx);
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, 'intercompany receiver');
    throw err;
  } finally {
    client.release(unusable);
  }
}
