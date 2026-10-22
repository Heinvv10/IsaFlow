/**
 * Retry a capture read that failed or went silent. The upload is stored, so the retry re-arms the row and a second
 * job reads it again from Storage.
 *
 * ONE guarded UPDATE re-arms the row (`read_state = 'reading'`, `read_attempt + 1`, a fresh heartbeat, no error) and only
 * a row that is retryable matches: failed, or 'reading' and silent past the stale window (shown as interrupted); its
 * file stored and not found missing; still pending and not posted. The new attempt is what fences the old job: if it
 * is only slow, not dead, everything it writes later matches no row (captureReadJob). The job starts after COMMIT
 * (runAfterCommit) for the attempt the UPDATE returned.
 *
 * Before the UPDATE the same eligibility is read back, so each refusal can say why and a refusal burns no AI unit:
 * 'being_read' (a read is alive), 'not_retryable' (done, settled by a person, posted, or no stored file), 'missing'.
 * Then, as for an upload, at most MAX_READS_IN_FLIGHT reads per company ('too_many') and one AI unit ('rate_limited',
 * charged by the caller's `charge`). If the UPDATE matches nothing (a retry or a person got there first) the row is read
 * again to name the reason. A refusal writes nothing, which is what makes it safe under withAuth's commit-on-4xx.
 */

import { runAfterCommit } from '@/lib/afterCommit';
import { sql } from '@/lib/neon';
import { runCaptureRead } from './captureReadJob';
import { lockWithTimeout } from './captureRowLock';
import { effectiveReadState, NOT_STORED_ERROR, STALE_AFTER_MINUTES } from './captureReadState';

type Row = Record<string, unknown>;

/** Reads in flight per company; the same soft cap as the upload (pages/api/accounting/document-capture). */
export const MAX_READS_IN_FLIGHT = 5;

export type RetryRefusal = 'missing' | 'being_read' | 'not_retryable' | 'too_many' | 'rate_limited';
export type RetryOutcome = { ok: true; row: Row; attempt: number } | { ok: false; reason: RetryRefusal };

/**
 * Why the row cannot be retried right now, or null when it can. The read takes the row FOR UPDATE (bounded wait, held to
 * the end of the request), so a second retry of the same document waits for the first to COMMIT, then finds the row
 * reading and is refused BEFORE it charges an AI unit.
 */
async function refusalFor(companyId: string, documentId: string): Promise<RetryRefusal | null> {
  const row = await lockWithTimeout(documentId, async () => (await sql`
    SELECT read_state, read_error, read_heartbeat_at, created_at, storage_path, posted_at, status
    FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
    FOR UPDATE
  `) as Row[]);
  if (!row) return 'missing';
  const state = effectiveReadState(row);
  if (state.readState === 'reading') return 'being_read';
  return state.retryable ? null : 'not_retryable';
}

// SOFT cap: retries of DIFFERENT documents lock different rows, so concurrent ones can each see room and exceed it by a few.
async function readsInFlight(companyId: string): Promise<number> {
  const [row] = (await sql`
    SELECT COUNT(*)::int AS n FROM captured_documents
    WHERE company_id = ${companyId} AND read_state = 'reading'
      AND COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
  `) as Row[];
  return Number(row?.n ?? 0);
}

/** Re-arm and start the read for `documentId`. `charge` takes one AI unit and says whether it was available. */
export async function retryCaptureRead(
  companyId: string, documentId: string, charge: () => Promise<boolean>,
): Promise<RetryOutcome> {
  const refused = await refusalFor(companyId, documentId);
  if (refused) return { ok: false, reason: refused };
  if (await readsInFlight(companyId) >= MAX_READS_IN_FLIGHT) return { ok: false, reason: 'too_many' };
  if (!(await charge())) return { ok: false, reason: 'rate_limited' };

  const [row] = (await sql`
    UPDATE captured_documents
    SET read_state = 'reading', read_error = NULL, read_heartbeat_at = NOW(), read_attempt = read_attempt + 1
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
      AND posted_at IS NULL AND status = 'pending'
      AND storage_path IS NOT NULL AND storage_path <> ''
      AND read_error IS DISTINCT FROM ${NOT_STORED_ERROR}
      AND (read_state = 'failed'
           OR (read_state = 'reading'
               AND COALESCE(read_heartbeat_at, created_at) < NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})))
    RETURNING *
  `) as Row[];
  if (!row) return { ok: false, reason: (await refusalFor(companyId, documentId)) ?? 'not_retryable' };

  const attempt = Number(row.read_attempt);
  runAfterCommit('capture-read', () => runCaptureRead(companyId, documentId, attempt));
  return { ok: true, row, attempt };
}
