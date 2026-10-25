/**
 * The app-pool writes a mirror scan makes on a connection row, its scan log and
 * its counters (S-07e part B, migration 946), shared by imapMirrorService and
 * sentMirrorService.
 *
 * An app role can lock a connection row (FOR UPDATE needs only the column UPDATE
 * it holds), and an INSERT into a scan log takes a key-share lock on that row
 * through its foreign key. The cron scans its connections one after another, so
 * an unbounded wait on one locked row would stall every connection behind it.
 * Outside a request each write therefore runs in a short transaction of its own
 * that waits at most SCAN_LOCK_WAIT for the row (`set_config(..., true)` is
 * transaction-local, so the pooled connection is not left with it). A write
 * that gives up (55P03) makes the scan skip its connection for this tick:
 * isScanLockSkip tells the caller, which warns and moves on without marking the
 * connection failed and without advancing its cursor (the next tick re-scans,
 * and ingestion de-duplicates by content hash).
 *
 * Inside a request (scan-now) the writes run on the request's own transaction,
 * whose lock_timeout must not change for the rest of the request.
 */
import { als } from '@/lib/als';
import { sql, withTransaction } from '@/lib/neon';

/** SQLSTATE lock_not_available. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** How long a write outside a request waits for a row another transaction holds. */
export const SCAN_LOCK_WAIT = '2s';

export type ScanTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/** Runs `write` with a tagged-template runner: the request's `sql`, or a bounded-wait transaction's. */
export async function scanWrite(write: (q: ScanTag) => Promise<unknown>): Promise<void> {
  if (als.getStore()?.client) {
    await write(sql);
    return;
  }
  await withTransaction(async (tx) => {
    await tx`SELECT set_config('lock_timeout', ${SCAN_LOCK_WAIT}, true)`;
    await write(tx);
  });
}

/** True when `err` is a bounded wait that ran out, outside a request: skip this connection for this tick. */
export function isScanLockSkip(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE && !als.getStore()?.client;
}
