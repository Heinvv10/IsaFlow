/**
 * A mirror scan's failure, recorded on its connection row (S-07e part B,
 * migration 946). Shared by imapMirrorService and sentMirrorService.
 *
 * Flipping `status` to 'error' is not a scan stamp, so no app role may write
 * it: it runs on the migration_admin pool, from a fixed statement per table,
 * keyed on the connection AND its company (that role bypasses RLS). The
 * last_scan_at / last_error stamp is the app pool's own and stays available.
 *
 * Inside a request (scan-now) the request's transaction already holds this
 * row, from the scan's cursor stamp. A migration_admin write would wait on
 * that lock until its lock_timeout, so the flip is deferred until the request
 * has committed, and only the stamp is written meanwhile.
 *
 * Never throws: the cron scans many connections and one connection's
 * bookkeeping must not stop the tick.
 */

import { als } from '@/lib/als';
import { runAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';

export type MirrorKind = 'imap' | 'sent';
export interface MirrorRef { id: string; companyId: string }

/** SQLSTATE lock_not_available: migration_admin's lock_timeout ran out on a row another transaction holds. */
const LOCK_NOT_AVAILABLE = '55P03';

const FLIP_STATUS = {
  imap: `UPDATE imap_mirror_connections
            SET last_scan_at = NOW(),
                last_error = $3,
                status = CASE WHEN status = 'active' THEN 'error' ELSE status END
          WHERE id = $1::uuid AND company_id = $2::uuid`,
  sent: `UPDATE sent_mirror_connections
            SET last_scan_at = NOW(),
                last_error = $3,
                status = CASE WHEN status = 'active' THEN 'error' ELSE status END
          WHERE id = $1::uuid AND company_id = $2::uuid`,
} as const;

const SCOPE = { imap: 'imap-mirror', sent: 'sent-mirror' } as const;

/** How long the fallback stamp waits for a row lock outside a request. */
const STAMP_LOCK_TIMEOUT = '2s';

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/** The stamp statement, run through `run` (the request's `sql`, or a transaction's tag). */
async function writeStamp(run: Tag, kind: MirrorKind, conn: MirrorRef, error: string): Promise<void> {
  if (kind === 'imap') {
    await run`
      UPDATE imap_mirror_connections
      SET last_scan_at = NOW(), last_error = ${error}
      WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
    `;
  } else {
    await run`
      UPDATE sent_mirror_connections
      SET last_scan_at = NOW(), last_error = ${error}
      WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
    `;
  }
}

/**
 * The stamp alone, on the app pool: the error is recorded, the status is not touched.
 *
 * Outside a request (the cron) it runs in a short transaction of its own that waits at most
 * STAMP_LOCK_TIMEOUT for the row: an app role can lock a connection row (FOR UPDATE needs only
 * the column UPDATE it has), and the cron's connections are scanned one after another, so an
 * unbounded wait here would stall the whole tick. On 55P03 it warns and moves on; the next
 * failing scan stamps again. Inside a request it runs on the request's own transaction, which
 * must not have its lock_timeout changed for the rest of the request.
 */
async function stampError(kind: MirrorKind, conn: MirrorRef, error: string): Promise<void> {
  try {
    if (als.getStore()?.client) {
      await writeStamp(sql, kind, conn, error);
      return;
    }
    await withTransaction(async (tx) => {
      await tx`SELECT set_config('lock_timeout', ${STAMP_LOCK_TIMEOUT}, true)`;
      await writeStamp(tx, kind, conn, error);
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === LOCK_NOT_AVAILABLE) {
      log.warn('mirror scan error stamp timed out on a row lock; skipped', { connectionId: conn.id, kind, code }, SCOPE[kind]);
    } else {
      log.error('mirror scan error stamp failed', { connectionId: conn.id, kind, err }, SCOPE[kind]);
    }
  }
}

async function flipStatus(kind: MirrorKind, conn: MirrorRef, error: string): Promise<void> {
  try {
    await migrationAdminTx(`mark ${kind} mirror scan error`, (client) => client.query(
      FLIP_STATUS[kind], [conn.id, conn.companyId, error],
    ));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === LOCK_NOT_AVAILABLE) {
      log.warn('mirror scan error status write timed out on a row lock; stamping the error only',
        { connectionId: conn.id, kind, code }, SCOPE[kind]);
    } else {
      log.error('mirror scan error status write failed; stamping the error only',
        { connectionId: conn.id, kind, code, err }, SCOPE[kind]);
    }
    await stampError(kind, conn, error);
  }
}

export async function markMirrorScanError(kind: MirrorKind, conn: MirrorRef, error: string): Promise<void> {
  const store = als.getStore();
  if (store && !store.finished && store.afterCommit) {
    await stampError(kind, conn, error);
    runAfterCommit(`flip ${kind} mirror status`, () => flipStatus(kind, conn, error));
    return;
  }
  await flipStatus(kind, conn, error);
}
