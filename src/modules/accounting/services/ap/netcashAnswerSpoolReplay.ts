/**
 * Moves spooled Netcash answers (netcashAnswerSpool) into audit_log once the database is healthy (AP-01 residual 3a),
 * so the durable record resolve reads is the same one it always was. Called from resolve and from submit (no cron):
 * with an empty spool it is one directory listing. An entry is written exactly once: the record is looked up by its
 * settle token first (an earlier replay may have committed and died before the rename), and the file is renamed
 * `.replayed` - never deleted - only after the insert committed. One replay at a time per process; never throws.
 */
import { log } from '@/lib/logger';
import { markReplayed, pendingSpooled, type AnswerRecord } from './netcashAnswerSpool';
import { inAnswerTx, insertAnswerRecord, UNRECORDED_ANSWER_ENTITY } from './netcashUnrecordedAnswer';

let running: Promise<number> | null = null;

async function replayOne(entry: AnswerRecord): Promise<void> {
  // audit_log's RLS reads the user from the claims' `sub`; the original claims are not kept, only that.
  const principal = { companyId: entry.companyId, userId: entry.userId, claims: entry.sub ? { sub: entry.sub } : {} };
  await inAnswerTx(principal, entry.submissionId, 'netcash spool replay', async (q) => {
    const { rows } = await q.query(
      `SELECT 1 FROM audit_log
       WHERE company_id = $1::UUID AND entity_type = $2 AND entity_id = $3::UUID AND changes -> 'metadata' ->> 'settleToken' = $4 LIMIT 1`,
      [entry.companyId, UNRECORDED_ANSWER_ENTITY, entry.submissionId, entry.metadata.settleToken]);
    if (!rows[0]) await insertAnswerRecord(q, entry);
  });
}

async function replayAll(): Promise<number> {
  let done = 0;
  try {
    for (const { file, entry } of await pendingSpooled()) {
      try {
        await replayOne(entry);
        await markReplayed(file);
        done += 1;
      } catch (err) {
        // The database (or the disk) is still unwell: stop here, the rest waits for the next call. Nothing is lost - the
        // entry stays pending and keeps blocking its submission.
        log.warn('netcash spool replay stopped - an entry could not be moved into audit_log yet', {
          submissionId: entry.submissionId, error: err instanceof Error ? err.message : String(err),
        }, 'netcash');
        break;
      }
    }
  } catch (err) {
    log.error('netcash spool replay could not read the spool', { error: err instanceof Error ? err.message : String(err) }, 'netcash');
  }
  return done;
}

/** Replay every pending spooled answer; resolves with how many were moved. Concurrent calls share one run. Never throws. */
export function replaySpooledAnswers(): Promise<number> {
  if (!running) running = replayAll().finally(() => { running = null; });
  return running;
}
