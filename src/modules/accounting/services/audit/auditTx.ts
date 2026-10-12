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

/** A whole snapshot may take this long; past it, it is abandoned (snapshotService tightens each step to what is left). */
export const SNAPSHOT_TIME_BUDGET_MS = 120_000;

/** The longest an automatic job waits for a process slot, and again for its company's snapshot lock; then it is refused. */
export const AUDIT_WAIT_MS = 5 * 60_000;

/** statement_timeout for the rest of this transaction: `ms`, or the current setting when that is tighter (never loosened). */
export async function tightenStatementTimeout(client: PoolClient, ms: number): Promise<void> {
  await client.query(
    `SELECT set_config('statement_timeout', $1::text, true) FROM pg_catalog.pg_settings
     WHERE name = 'statement_timeout' AND (setting::bigint = 0 OR setting::bigint > $1::bigint)`,
    [Math.max(1, Math.ceil(ms))]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The person behind the current request (withAuth / the MCP bearer pipeline). */
export function principalFromRequest(): AuditPrincipal {
  const store = als.getStore();
  if (!store?.companyId || !store.userId) throw new Error('audit: no request principal (called outside withAuth or MCP)');
  return { userId: store.userId, companyId: store.companyId, claims: { ...store.claims } };
}

export class SnapshotBusyError extends Error {
  constructor(message = 'An audit snapshot is already being taken for this company. Try again when it has finished.') {
    super(message);
    this.name = 'SnapshotBusyError';
  }
}

/**
 * `chainLock`: hold this company's snapshot lock for the whole transaction — one snapshot at a time per company, so
 * its chain position is read and written by one writer. A SESSION lock taken BEFORE BEGIN: a REPEATABLE READ
 * transaction fixes its view at its first statement, so a lock taken inside it would still read the chain as it was
 * before the snapshot it waited for. 'try' refuses (SnapshotBusyError) instead of waiting; `{ waitMs }` waits that
 * long at most (a holder that hangs, in another process, cannot stall the company's automatic snapshots for ever).
 */
export async function runAuditTx<T>(p: AuditPrincipal, isolation: 'REPEATABLE READ' | 'READ COMMITTED',
  fn: (client: PoolClient) => Promise<T>, opts: { chainLock?: 'try' | { waitMs: number } } = {}): Promise<T> {
  const client = await getPool().connect();
  let unusable = false;
  const lockKey = `audit_snapshot_chain:${p.companyId}`;
  let locked = false;
  let begun = false;
  try {
    if (opts.chainLock === 'try') {
      const { rows: [r] } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
      if (!r?.ok) throw new SnapshotBusyError();
      locked = true;
    } else if (opts.chainLock) {
      const until = Date.now() + opts.chainLock.waitMs;
      for (;;) {
        const { rows: [r] } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
        if (r?.ok) break;
        if (Date.now() >= until) {
          throw new SnapshotBusyError(`This company's previous audit snapshot still held its lock after ${Math.round(opts.chainLock.waitMs / 1000)} s.`);
        }
        await sleep(Math.min(500, opts.chainLock.waitMs));
      }
      locked = true;
    }
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    begun = true;
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    await tightenStatementTimeout(client, AUDIT_STATEMENT_TIMEOUT_MS);
    const out = await als.run({ client, userId: p.userId, companyId: p.companyId, claims: p.claims }, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // Once BEGIN ran the transaction (with this person's claims) is rolled back, whatever was thrown.
    if (begun) unusable = await rollbackFailed(client, 'audit snapshot');
    log.warn('audit transaction rolled back', { companyId: p.companyId, error: err instanceof Error ? err.message : String(err) }, 'audit');
    throw err;
  } finally {
    if (locked && !unusable) {
      // A connection that keeps a session lock must not go back to the pool.
      unusable = await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .then(() => false, (e: unknown) => { log.error('audit: chain lock not released', { error: String(e) }, 'audit'); return true; });
    }
    client.release(unusable);
  }
}

/** The transaction's now(), as the writers compare it: UTC, microseconds. */
export async function transactionNow(client: PoolClient): Promise<string> {
  const { rows: [r] } = await client.query<{ t: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`);
  return r!.t;
}
