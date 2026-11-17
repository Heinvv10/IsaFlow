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

/** How long a caller waits for the sweep (its pool checkout included) before going on without it. */
export const SWEEP_WAIT_MS = 2_000;

/**
 * The sweep for a caller that must not fail on it (both tools, the PUT route): a failure is logged and dropped, and the
 * caller waits at most SWEEP_WAIT_MS. A tool calls it while its own request transaction holds a pool connection, so a
 * busy pool could otherwise stall the tool for the whole connect timeout; past the wait the sweep finishes (or fails,
 * logged) in the background on its own connection.
 */
export async function sweepExpiredUploadsQuietly(waitMs: number = SWEEP_WAIT_MS): Promise<void> {
  const run = sweepExpiredUploads().then(({ cleared, deleted }) => {
    if (cleared > 0 || deleted > 0) log.info('MCP upload sweep', { cleared, deleted }, 'mcp-uploads');
  }, (err: unknown) => {
    log.warn('MCP upload sweep failed; the next call retries', {
      error: err instanceof Error ? err.message : String(err),
    }, 'mcp-uploads');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
  await Promise.race([run, waited]);
  if (timer) clearTimeout(timer);
}

/**
 * The sweep every caller uses (both tools, the PUT route): at most once per SWEEP_MIN_INTERVAL_MS per process, so a
 * burst of calls is not a burst of background sweeps queueing for pool connections.
 */
export const SWEEP_MIN_INTERVAL_MS = 10_000;
let lastThrottledSweepAt = Number.NEGATIVE_INFINITY;

/** Sweeps (quietly) unless this process swept within the interval; true when it ran. */
export async function sweepExpiredUploadsThrottled(now: number = Date.now()): Promise<boolean> {
  if (now - lastThrottledSweepAt < SWEEP_MIN_INTERVAL_MS) return false;
  lastThrottledSweepAt = now;
  await sweepExpiredUploadsQuietly();
  return true;
}
