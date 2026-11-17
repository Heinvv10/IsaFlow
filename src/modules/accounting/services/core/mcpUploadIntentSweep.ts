/**
 * The global sweep of mcp_upload_intents (999q): run by both MCP upload tools and the PUT route, across EVERY company,
 * on the service pool (app_service: the tools' own app_user transaction sees only its company).
 *
 *   1. An expired row's staged bytes are cleared (bounded batch). The row stays and reads 'expired', not 'not found'.
 *   2. An unfinalized row 7 days past its expiry is deleted (bounded batch). Finalized rows stay: they carry no bytes and
 *      an entity target's dedup reads them.
 *
 * Its own short statements on its own connection, never the caller's transaction, with SKIP LOCKED: a row the caller
 * (or any other transaction) holds is left for the next sweep, so the sweep never waits on, or deadlocks with, the
 * transaction that called it. The sweep is housekeeping: sweepExpiredUploadsQuietly logs a failure and never throws.
 */
import { getDbPool } from '@/lib/neon';
import { log } from '@/lib/logger';

/** Rows touched per statement: bounded so a call never stalls on a backlog; the next call takes the next batch. */
const SWEEP_BATCH = 200;
/** An unfinalized row is kept this long past its expiry (so it reads 'expired'), then deleted. */
const KEEP_EXPIRED_DAYS = 7;

/** What the sweep runs on: the service pool, or (tests) a client already in the service role. */
export interface SweepDb {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export async function sweepExpiredUploads(db: SweepDb = getDbPool()): Promise<{ cleared: number; deleted: number }> {
  const cleared = await db.query(
    `UPDATE mcp_upload_intents SET staged_bytes = NULL
      WHERE id IN (SELECT id FROM mcp_upload_intents
                    WHERE staged_bytes IS NOT NULL AND expires_at <= now()
                    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [SWEEP_BATCH],
  );
  const deleted = await db.query(
    `DELETE FROM mcp_upload_intents
      WHERE id IN (SELECT id FROM mcp_upload_intents
                    WHERE status <> 'finalized' AND expires_at <= now() - make_interval(days => $2)
                    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [SWEEP_BATCH, KEEP_EXPIRED_DAYS],
  );
  return { cleared: cleared.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}

/** The sweep for a caller that must not fail on it (both tools, the PUT route): a failure is logged and dropped. */
export async function sweepExpiredUploadsQuietly(): Promise<void> {
  try {
    const { cleared, deleted } = await sweepExpiredUploads();
    if (cleared > 0 || deleted > 0) log.info('MCP upload sweep', { cleared, deleted }, 'mcp-uploads');
  } catch (err) {
    log.warn('MCP upload sweep failed; the next call retries', {
      error: err instanceof Error ? err.message : String(err),
    }, 'mcp-uploads');
  }
}
