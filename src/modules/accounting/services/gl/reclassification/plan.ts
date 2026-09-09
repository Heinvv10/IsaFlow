/**
 * The plan a reclassification would carry out — everything both tools need,
 * computed once, with no write anywhere in it.
 *
 * `propose_reclassification` returns this. `post_reclassification_batch` builds
 * the SAME plan and then posts its drafts, which is what makes the dry run
 * honest: every row-state guard the live path runs has already run by the time
 * the two diverge, and only the write itself is skipped.
 *
 * A REFUSAL IS ABOUT THE REQUEST; A SKIP IS ABOUT THE DATA. A refusal comes back
 * as `ReclassRefusal` and the caller renders it as a `toolError` — the agent has
 * to change what it sent. A skip is a fact about one line and never costs the
 * other 418.
 */

import { fmtDate } from '@/lib/fmtDate';
import { withSavepoint } from '@/lib/neon';
import { lockReclassLinesForUpdate } from './lineLock';
import { getLedgerPostedThrough } from '../../reports/postedThroughService';
import {
  admitReclassification,
  isRefusal,
  type ReclassAccount,
  type ReclassRefusal,
} from './planGuards';

// Re-exported so a caller keeps ONE import for the plan and its refusal shape.
export { isRefusal } from './planGuards';
export type { ReclassAccount, ReclassRefusal } from './planGuards';
import {
  countReclassCandidates,
  findReclassCandidates,
  partitionCandidates,
  type ReclassCandidate,
  type ReclassSkip,
} from './candidates';
import { buildReclassJournals, type ReclassJournalDraft } from './journals';
import { computeReclassImpact, type ReclassImpact } from './impact';
import { reclassWarnings, targetPriorSources, type ReclassWarning } from './warnings';

/** Above this, the caller narrows the window rather than the tool truncating. */
export const MAX_RECLASS_LINES = 500;

export interface ReclassPlanInput {
  companyId: string;
  sourceAccountId: string;
  targetAccountId: string;
  /** Inclusive bounds on the SOURCE entry date, or null. */
  from: string | null;
  to: string | null;
  /** One date for every journal, or null to date each at its source line. */
  postingDate: string | null;
  /**
   * Row-lock the candidate lines and re-evaluate them under the lock.
   *
   * TRUE only on the path that is about to WRITE. A dry run and
   * `propose_reclassification` write nothing, so holding locks on hundreds of
   * posted lines for the length of a preview would block every real batch on
   * them for no benefit. The consequence is honest and small: a preview can be
   * overtaken by a batch that commits before it, exactly as a report can.
   */
  lockCandidateLines: boolean;
}

export interface ReclassPlan {
  /** Echoed from the input so the response reports what was ASKED for. */
  postingDate: string | null;
  source: ReclassAccount;
  target: ReclassAccount;
  movable: ReclassCandidate[];
  skipped: ReclassSkip[];
  /** Candidate lines before any guard, from its own COUNT. */
  universeTotal: number;
  drafts: ReclassJournalDraft[];
  impact: ReclassImpact;
  warnings: ReclassWarning[];
  postedThrough: string;
}

export interface ReclassPlan {
  /** Echoed from the input so the response reports what was ASKED for. */
  postingDate: string | null;
  source: ReclassAccount;
  target: ReclassAccount;
  movable: ReclassCandidate[];
  skipped: ReclassSkip[];
  /** Candidate lines before any guard, from its own COUNT. */
  universeTotal: number;
  drafts: ReclassJournalDraft[];
  impact: ReclassImpact;
  warnings: ReclassWarning[];
  postedThrough: string;
}

export async function planReclassification(
  input: ReclassPlanInput,
): Promise<ReclassPlan | ReclassRefusal> {
  const { companyId } = input;
  const admitted = await admitReclassification(input);
  if (isRefusal(admitted)) return admitted;
  const { source, target } = admitted;

  const query = { sourceAccountId: input.sourceAccountId, from: input.from, to: input.to };
  let rows = await findReclassCandidates(companyId, { ...query, limit: MAX_RECLASS_LINES });
  if (rows.length > MAX_RECLASS_LINES) {
    return {
      refused:
        `More than ${MAX_RECLASS_LINES} posted lines sit on ${source.code} in this window. ` +
        'Narrow it with from/to and run the move in several batches — truncating ' +
        'silently would post a partial reclassification nobody asked for.',
    };
  }

  // ── THE LOCK, and what makes it worth taking is the RE-READ below. ─────────
  //
  // Nothing else serialises two DIFFERENT requests over the same lines. The
  // registry's idempotency lock keys on (company, tool, idempotency_key), so two
  // batches carrying different keys — two agent sessions, or one agent retrying
  // under a fresh key after a timeout — never meet. All three duplicate-move
  // guards are read-committed reads of rows the peer has not committed yet, and
  // the (batch_id, source_line_id) unique index is per BATCH, so two batch ids
  // cannot collide. Both runs would otherwise post the same R11.3m.
  //
  // The lock alone fixes nothing. Held across the INSERT only, both batches
  // would still have DECIDED on stale reads. So the sequence is: read to learn
  // the ids, LOCK them, then read AGAIN and evaluate every guard on that second
  // read. The peer's batch rows are committed by the time we are unblocked, so
  // the second read reports its lines as `already_reclassified` and the batch
  // correctly does nothing.
  //
  // Write path only: `propose_reclassification` and a dry run take no lock, so
  // a preview never blocks a real batch on 414 posted lines. The same flag has
  // already decided the target-account lock inside `admitReclassification`, so
  // a preview holds nothing at all.
  //
  // IN ITS OWN SAVEPOINT, because the timeout is CAUGHT. A `lock_timeout`
  // raises 55P03, which aborts the (sub)transaction; catching the error does
  // not un-poison it, and `planFromArgs` turns `RECLASS_LINE_LOCKED` into a
  // toolError and RETURNS. The enclosing `withSavepoint` in `registry.call`
  // then issues `RELEASE SAVEPOINT` on its normal-return path, which raises
  // 25P02 — so the agent received GENERIC_FAILURE and the retry wording was
  // discarded. Only a savepoint rollback restores the transaction. Same shape
  // as `snapshotInvoicePdf` (mcp/.claude.md), and the reason is identical.
  let lockedLineIds: ReadonlySet<string> | undefined;
  if (input.lockCandidateLines) {
    const locked = await withSavepoint(
      'reclass_line_lock',
      () => lockReclassLinesForUpdate(companyId, rows.map((r) => r.line_id)),
    );
    lockedLineIds = new Set(locked);
    // The re-read. Same query, under the lock, so every row-state guard runs
    // against state no peer can now be holding uncommitted.
    rows = await findReclassCandidates(companyId, { ...query, limit: MAX_RECLASS_LINES });
    if (rows.length > MAX_RECLASS_LINES) {
      return {
        refused:
          `More than ${MAX_RECLASS_LINES} posted lines sit on ${source.code} in this window ` +
          'after waiting for a concurrent batch. Narrow it with from/to and run the move ' +
          'in several batches.',
      };
    }
  }

  const { movable, skipped } = partitionCandidates(rows, {
    postingDate: input.postingDate,
    ...(lockedLineIds === undefined ? {} : { lockedLineIds }),
  });
  // Its own COUNT over the unfiltered candidate predicate. NOT
  // `movable.length + skipped.length`, which would make the envelope's
  // completeness identity unable to fail whatever this function did.
  const universeTotal = await countReclassCandidates(companyId, query);

  const drafts = buildReclassJournals(
    movable,
    input.sourceAccountId,
    input.targetAccountId,
    {
      sourceCode: source.code, sourceName: source.name,
      targetCode: target.code, targetName: target.name,
    },
    input.postingDate,
  );

  // The window spans the source dates AND the posting date, so the projected
  // aggregate covers both ends of a cross-period move and the two sides stay
  // comparable.
  //
  // WHEN THERE ARE NO CANDIDATE ROWS AT ALL — a brand-new tenant, or an account
  // nobody has posted to — it falls back to the caller's own bounds and then to
  // TODAY. It used to fall back to `1970-01-01` and `9999-12-31`, which made
  // `as_at` on an empty report a date in the year 9999: a reporting date no
  // reader could act on, asserted by a report that had read nothing. Today is
  // the honest answer — "as at now, this account carries nothing" — and it also
  // keeps the impact scan trivially empty instead of scanning all of history.
  const dates = [
    ...movable.map((m) => m.entryDate),
    ...skipped.map((s) => s.entryDate),
    ...(input.postingDate === null ? [] : [input.postingDate]),
  ].filter((d) => d.length > 0).sort();
  const today = fmtDate(new Date());
  const window = {
    start: dates[0] ?? input.from ?? input.to ?? today,
    end: dates[dates.length - 1] ?? input.to ?? input.from ?? today,
  };

  const impact = await computeReclassImpact({
    companyId,
    window,
    movedLineIds: movable.map((m) => m.lineId),
    sourceAccountId: source.id,
    targetAccountId: target.id,
    targetAccountType: target.type,
    targetAccountSubtype: target.subtype,
    accountLabels: {
      [source.id]: { code: source.code, name: source.name },
      [target.id]: { code: target.code, name: target.name },
    },
  });

  const priorSources = await targetPriorSources(companyId, target.id, source.id);
  const warnings = reclassWarnings({
    universeTotal, source, target, movable, impact, priorSources,
  });
  const postedThrough = await getLedgerPostedThrough(companyId, window.end, window.start);

  return {
    postingDate: input.postingDate,
    source, target, movable, skipped, universeTotal,
    drafts, impact, warnings, postedThrough,
  };
}
