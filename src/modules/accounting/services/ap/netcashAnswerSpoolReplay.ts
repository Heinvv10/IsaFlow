/**
 * Moves spooled Netcash answers (netcashAnswerSpool) into audit_log once the database is healthy (AP-01 residual 3a),
 * so the durable record resolve reads is the same one it always was. Called from resolve (awaited) and from submit (not
 * awaited); no cron. With an empty spool it is one directory listing.
 *
 * Exactly once, in every process: the exists-check and the insert run under one transaction-scoped advisory lock on the
 * entry's settle token (two-int4 key, class NETCASH_SPOOL_REPLAY_LOCK_CLASS, which no other lock here shares), so two
 * processes replaying the same file serialise and the second finds the first's row; an earlier replay that committed
 * and died before moving the file is found the same way. The file is moved to replayed/ - never deleted - only after
 * the insert committed, and a move a peer already made is not an error.
 *
 * Bounded per call (SPOOL_REPLAY_MAX_ENTRIES, SPOOL_REPLAY_BUDGET_MS): the rest waits for the next call. One entry that
 * the database refuses for its OWN content (SQLSTATE 22xxx / 23xxx: a deleted company or user; 42501, a permission error, is NOT - a deploy-time grant gap must not quarantine valid entries) never blocks the
 * entries behind it: the run goes on, and after SPOOL_QUARANTINE_AFTER_FAILURES refusals (counted per process) the file
 * moves to quarantine/ with a log.error. A quarantined acceptance still blocks resolve (the spool lookup reads it). Any
 * other failure (the database or the disk is unwell) stops the run - every later entry would fail the same way.
 */
import { log } from '@/lib/logger';
import {
  markReplayed, pendingSpooled, quarantineEntry, sweepStaleTemps, type AnswerRecord,
} from './netcashAnswerSpool';
import { inAnswerTx, insertAnswerRecord, UNRECORDED_ANSWER_ENTITY } from './netcashUnrecordedAnswer';
import { SPOOL_QUARANTINE_AFTER_FAILURES, SPOOL_REPLAY_BUDGET_MS, SPOOL_REPLAY_MAX_ENTRIES } from './netcashTimeouts';

/** classid of the replay lock: 'NCSP' (0x4E435350); the send lock's is 'NCSD'. */
export const NETCASH_SPOOL_REPLAY_LOCK_CLASS = 0x4e435350;

export interface ReplayOptions { maxEntries?: number; budgetMs?: number }

let running: Promise<number> | null = null;
/** Refusals per file for the entry's own content, this process. */
const refusals = new Map<string, number>();

async function replayOne(entry: AnswerRecord): Promise<void> {
  // audit_log's RLS reads the user from the claims' `sub`; the original claims are not kept, only that.
  const principal = { companyId: entry.companyId, userId: entry.userId, claims: entry.sub ? { sub: entry.sub } : {} };
  await inAnswerTx(principal, entry.submissionId, 'netcash spool replay', async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1::INT4, hashtext($2))', [NETCASH_SPOOL_REPLAY_LOCK_CLASS, entry.metadata.settleToken]);
    const { rows } = await q.query(
      `SELECT 1 FROM audit_log
       WHERE company_id = $1::UUID AND entity_type = $2 AND entity_id = $3::UUID AND changes -> 'metadata' ->> 'settleToken' = $4 LIMIT 1 /* netcash_spool_replay_exists */`,
      [entry.companyId, UNRECORDED_ANSWER_ENTITY, entry.submissionId, entry.metadata.settleToken]);
    if (!rows[0]) await insertAnswerRecord(q, entry);
  });
}

/** The database refused this entry for what it contains (retrying cannot clear it), as opposed to being unwell. */
function refusedForItsContent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}

async function replayAll(opts: ReplayOptions): Promise<number> {
  const max = opts.maxEntries ?? SPOOL_REPLAY_MAX_ENTRIES;
  const deadline = Date.now() + (opts.budgetMs ?? SPOOL_REPLAY_BUDGET_MS);
  let done = 0;
  try {
    await sweepStaleTemps();
    let tried = 0;
    for (const { file, entry } of await pendingSpooled({ max, deadline })) {
      if (tried >= max || Date.now() >= deadline) break;
      tried += 1;
      try {
        await replayOne(entry);
        await markReplayed(file);
        refusals.delete(file);
        done += 1;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: unknown } | null)?.code;
        if (!refusedForItsContent(err)) {
          // The database (or the disk) is unwell: stop; nothing is lost - the entry stays pending and keeps blocking its submission.
          log.warn('netcash spool replay stopped - the database or disk is not answering', { submissionId: entry.submissionId, error, code }, 'netcash');
          break;
        }
        const n = (refusals.get(file) ?? 0) + 1;
        refusals.set(file, n);
        if (n < SPOOL_QUARANTINE_AFTER_FAILURES) {
          log.warn('netcash spool replay: the database refused this entry - going on with the next', { submissionId: entry.submissionId, attempt: n, error, code }, 'netcash');
          continue;
        }
        refusals.delete(file);
        log.error('netcash spool entry quarantined - the database keeps refusing it; it still blocks freeing its submission (check Netcash)', {
          submissionId: entry.submissionId, companyId: entry.companyId, file, error, code,
        }, 'netcash');
        await quarantineEntry(file);
      }
    }
  } catch (err) {
    log.error('netcash spool replay failed outside an entry', { error: err instanceof Error ? err.message : String(err) }, 'netcash');
  }
  return done;
}

/** Replay pending spooled answers (bounded); resolves with how many were moved. Concurrent calls share one run. Never throws. */
export function replaySpooledAnswers(opts: ReplayOptions = {}): Promise<number> {
  if (!running) running = replayAll(opts).finally(() => { running = null; });
  return running;
}
