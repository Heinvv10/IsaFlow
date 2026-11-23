/**
 * Fixture for the intercompany P4-C (receiver allocation inbox) suites, on top of the P4-B one: B (the payer) pays A's invoice through its
 * linked bill, the database writes the allocation message B -> A, and A (the RECEIVER) asks `intercompany_allocation_message_live` whether it
 * is still true, as app_user in A's session (withAuth's shape). The route helpers call the real allocation routes with real signed tokens.
 */
import type { Pool, PoolClient } from 'pg';
import allocationsRoute from '../../../pages/api/accounting/intercompany/allocations';
import allocationRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/index';
import allocationRejectRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/reject';
import allocationDismissRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/dismiss';
import allocationRestoreRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/restore';
import { callRoute } from '../r035-approval.helpers';
import { asAppUser, co, tokens, U } from './intercompany.helpers';
import { plantBill, plantPaid, sendFor } from './allocation.helpers';

export interface LiveRow { live: boolean; reason: string }

const LIVE = 'SELECT live, reason FROM public.intercompany_allocation_message_live($1)';

/** The definer as `user` acting as `company` (the receiver A by default), rolled back: every row it answers. */
export const liveRows = (pool: Pool, message: string, user = U.a, company = co.A) =>
  asAppUser(pool, user, company, async (q) => (await q.query(LIVE, [message])).rows as LiveRow[]);

/** The one answer (the definer always answers exactly one row). */
export async function liveFor(pool: Pool, message: string, user = U.a, company = co.A): Promise<LiveRow> {
  const rows = await liveRows(pool, message, user, company);
  if (rows.length !== 1) throw new Error(`the definer answered ${rows.length} rows`);
  return rows[0]!;
}

/** The definer in a session with no signed-in user (app_user, the company GUC set or not): what a caller outside a request sees. */
export async function liveWithoutUser(pool: Pool, message: string, company: string | null): Promise<LiveRow[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    if (company) await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    return (await client.query(LIVE, [message])).rows as LiveRow[];
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** A linked bill of B paid by a processed payment on a standing journal, and the allocation message the database wrote for A. */
export async function sentAllocation(pool: Pool, conn: string, over: Parameters<typeof plantPaid>[2] = {}, bill: Parameters<typeof plantBill>[2] = {}) {
  const b = await plantBill(pool, conn, bill);
  const p = await plantPaid(pool, b.bill, over);
  const out = await sendFor(pool, p.allocation);
  if (!out.message_id) throw new Error(`the allocation was not sent: ${out.reason}`);
  return { ...b, ...p, message: out.message_id };
}

const base = '/api/accounting/intercompany/allocations';
export const allocationsApi = {
  list: (user: string, company: string, query: Record<string, string> = {}) =>
    callRoute(allocationsRoute, tokens[user]!, company, 'GET', undefined, base, query),
  get: (user: string, company: string, id: string) =>
    callRoute(allocationRoute, tokens[user]!, company, 'GET', undefined, `${base}/${id}`, { id }),
  reject: (user: string, company: string, id: string, body: unknown) =>
    callRoute(allocationRejectRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/reject`, { id }),
  dismiss: (user: string, company: string, id: string) =>
    callRoute(allocationDismissRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/dismiss`, { id }),
  restore: (user: string, company: string, id: string) =>
    callRoute(allocationRestoreRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/restore`, { id }),
};
