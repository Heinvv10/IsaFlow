/**
 * The transaction an audit snapshot or check run is taken in: its OWN pooled
 * connection (never the request's), REPEATABLE READ so every read sees one
 * moment of the books, as app_user with the person's claims and company GUC —
 * so RLS binds every read and the writers can tell who is recording.
 *
 * The services it calls (trial balance, ageing, the integrity checks, the
 * change history) use `sql`, which follows the ALS client: they run inside
 * this transaction without knowing it.
 *
 * statement_timeout is tightened to the snapshot cap, never loosened.
 */
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';

export interface AuditPrincipal {
  userId: string;
  companyId: string;
  /** The request's JWT claims (session_id included) — the writers read the channel from them. */
  claims: Record<string, unknown>;
}

/** Statements in a snapshot transaction may run this long, and no longer. */
export const AUDIT_STATEMENT_TIMEOUT_MS = 60_000;

/** The person behind the current request (withAuth / the MCP bearer pipeline). */
export function principalFromRequest(): AuditPrincipal {
  const store = als.getStore();
  if (!store?.companyId || !store.userId) throw new Error('audit: no request principal (called outside withAuth or MCP)');
  return { userId: store.userId, companyId: store.companyId, claims: { ...store.claims } };
}

export async function runAuditTx<T>(p: AuditPrincipal, isolation: 'REPEATABLE READ' | 'READ COMMITTED',
  fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let unusable = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    await client.query(
      `SELECT set_config('statement_timeout', $1::text, true) FROM pg_catalog.pg_settings
       WHERE name = 'statement_timeout' AND (setting::bigint = 0 OR setting::bigint > $1::bigint)`,
      [AUDIT_STATEMENT_TIMEOUT_MS]);
    const out = await als.run({ client, userId: p.userId, companyId: p.companyId, claims: p.claims }, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    unusable = await rollbackFailed(client, 'audit snapshot');
    log.warn('audit transaction rolled back', { companyId: p.companyId, error: err instanceof Error ? err.message : String(err) }, 'audit');
    throw err;
  } finally {
    client.release(unusable);
  }
}

/** The transaction's now(), as the writers compare it: UTC, microseconds. */
export async function transactionNow(client: PoolClient): Promise<string> {
  const { rows: [r] } = await client.query<{ t: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
  return r!.t;
}
