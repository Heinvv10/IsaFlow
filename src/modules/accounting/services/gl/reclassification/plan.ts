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

import { getAccountById } from '../chartOfAccountsService';
import { getPeriodStatusForDate } from '../periodStatusService';
import { isVatPeriodLocked } from '../../reports/vatPeriodLockService';
import { lockReclassSource } from './sourceLock';
import { getLedgerPostedThrough } from '../../reports/postedThroughService';
import type { AccountType } from '../accountClassification';
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

export interface ReclassAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  isActive: boolean;
}

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
   * Take an advisory lock on the source account before reading candidates.
   *
   * TRUE only on the path that is about to WRITE. A dry run and
   * `propose_reclassification` write nothing, so holding a lock that blocks
   * every real batch on the account for the length of a preview would be a
   * denial of service dressed as safety. The consequence is honest and small:
   * a preview can be overtaken by a batch that commits before it, exactly as a
   * report can.
   */
  lockSourceAccount: boolean;
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

/** A fault in the REQUEST. The caller returns it as a pre-write toolError. */
export interface ReclassRefusal {
  refused: string;
}

export function isRefusal(x: ReclassPlan | ReclassRefusal): x is ReclassRefusal {
  return 'refused' in x;
}

/**
 * The subtypes `vatReturnService` uses to decide VAT201 membership.
 *
 * A line on one of these accounts is ON the return, and a line on one of them
 * with a NULL `vat_type` is swept into **box 15 at full value**. This tool can
 * move arbitrary posted lines, so a move onto such an account rewrites a
 * statutory return as a side effect of a housekeeping operation. That is
 * refused outright rather than warned about: a warning an agent can ignore is
 * not a control on a SARS submission.
 *
 * `'tax'` is in the set even though FINDINGS B37 records that it is NOT VAT —
 * Brightsphere's PAYE account carries it — precisely because `vatReturnService`
 * treats it as VAT today. The set mirrors what the return actually reads, not
 * what it ought to read; narrowing it here would silently re-open the hole
 * while that defect stands.
 */
const VAT_RETURN_SUBTYPES = new Set(['vat_input', 'vat_output', 'tax']);

async function loadAccount(
  companyId: string,
  id: string,
): Promise<ReclassAccount | null> {
  const account = await getAccountById(companyId, id);
  if (!account) return null;
  return {
    id: account.id,
    code: account.accountCode,
    name: account.accountName,
    type: account.accountType as AccountType,
    subtype: account.accountSubtype ?? null,
    isActive: account.isActive,
  };
}

export async function planReclassification(
  input: ReclassPlanInput,
): Promise<ReclassPlan | ReclassRefusal> {
  const { companyId } = input;
  if (input.sourceAccountId === input.targetAccountId) {
    return { refused: 'source_account_id and target_account_id must differ.' };
  }
  if (input.from !== null && input.to !== null && input.to < input.from) {
    return { refused: 'to must not precede from.' };
  }

  // Ownership, from a READ, with the shared NOT_FOUND text supplied by the
  // caller: a cross-tenant id must read identically to a typo'd one.
  const source = await loadAccount(companyId, input.sourceAccountId);
  if (!source) return { refused: 'NOT_FOUND' };
  const target = await loadAccount(companyId, input.targetAccountId);
  if (!target) return { refused: 'NOT_FOUND' };

  // A deactivated account refuses every posting (`assertNoInactiveAccountLines`),
  // so EVERY journal in the batch would fail. That is a fault in the request —
  // refused here, before anything is written, rather than discovered on line 1
  // of 419 with a generic failure.
  if (!source.isActive) {
    return {
      refused:
        `Source account ${source.code} is deactivated, so the contra leg cannot post. ` +
        'Reactivate it for the duration of the reclassification.',
    };
  }
  if (!target.isActive) {
    return {
      refused:
        `Target account ${target.code} is deactivated and cannot receive a posting. ` +
        'Reactivate it, or choose another target.',
    };
  }

  // The posting date's OWN period, validated before any candidate is read. Both
  // states get their own message because the remedies differ: create the fiscal
  // year, versus re-open the period.
  if (input.postingDate !== null) {
    const status = await getPeriodStatusForDate(companyId, input.postingDate);
    if (status === 'no_period') {
      return {
        refused:
          `No fiscal period covers posting_date ${input.postingDate}. Create the fiscal ` +
          'year first — a journal outside every period is invisible to the trial ' +
          'balance, the VAT201 and the AFS.',
      };
    }
    if (status !== 'open') {
      return { refused: `The fiscal period covering posting_date ${input.postingDate} is closed.` };
    }
  }

  for (const account of [source, target]) {
    if (account.subtype !== null && VAT_RETURN_SUBTYPES.has(account.subtype)) {
      return {
        refused:
          `${account.code} ${account.name} is a VAT control account (subtype ` +
          `${account.subtype}), and the VAT201 is built from the lines sitting on ` +
          'those accounts. Moving lines on or off one rewrites a statutory return, ' +
          'and a line landing there with no vat_type is swept into box 15 at full ' +
          'value. Reclassify VAT control accounts through the VAT tools, not this one.',
      };
    }
  }

  // A line that CARRIES VAT coding and sits in a filed period is anchored to a
  // return already sent to SARS. Per line, so one such line never costs the
  // rest of the batch; refused up front only for a posting_date, where the
  // whole batch would land in the locked period.
  if (input.postingDate !== null && (await isVatPeriodLocked(companyId, input.postingDate))) {
    return {
      refused:
        `posting_date ${input.postingDate} falls inside a filed VAT period. Choose a ` +
        'date outside it, or omit posting_date so each journal is dated at its own ' +
        'source line.',
    };
  }

  // ── THE LOCK, and it must be here: BEFORE the candidates are read. ────────
  //
  // Nothing else serialises two DIFFERENT requests over the same rows. The
  // registry's idempotency lock keys on (company, tool, idempotency_key), so
  // two batches carrying different keys — two agent sessions, or one agent
  // retrying under a fresh key after a timeout — never meet. All three
  // duplicate-move guards (`already_reclassified`, `is_reclass_contra`, the
  // (batch_id, source_line_id) unique index) are read-committed reads of rows
  // the other transaction has not committed yet, and the unique index is
  // per-batch, so two batch ids never collide. Both runs would post the same
  // R11.3m: the source account overdrawn by the full amount, the target
  // overstated by it, and two live batches to unwind.
  //
  // Held to the end of the request transaction, so the second caller waits,
  // then RE-READS the candidates below and finds them `already_reclassified` —
  // which is why the lock is taken before the read and not around the write.
  //
  // Only the SOURCE account is locked. Locking the target too would let
  // A→B and B→A deadlock on each other, and target contention is not a
  // correctness problem: two batches with different sources cannot move the
  // same line.
  if (input.lockSourceAccount) {
    await lockReclassSource(companyId, input.sourceAccountId);
  }

  const query = { sourceAccountId: input.sourceAccountId, from: input.from, to: input.to };
  const rows = await findReclassCandidates(companyId, { ...query, limit: MAX_RECLASS_LINES });
  if (rows.length > MAX_RECLASS_LINES) {
    return {
      refused:
        `More than ${MAX_RECLASS_LINES} posted lines sit on ${source.code} in this window. ` +
        'Narrow it with from/to and run the move in several batches — truncating ' +
        'silently would post a partial reclassification nobody asked for.',
    };
  }

  const { movable, skipped } = partitionCandidates(rows, { postingDate: input.postingDate });
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
  // comparable. Falls back to the caller's bounds when nothing is movable.
  const dates = [
    ...movable.map((m) => m.entryDate),
    ...skipped.map((s) => s.entryDate),
    ...(input.postingDate === null ? [] : [input.postingDate]),
  ].filter((d) => d.length > 0).sort();
  const window = {
    start: dates[0] ?? input.from ?? '1970-01-01',
    end: dates[dates.length - 1] ?? input.to ?? '9999-12-31',
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
  const warnings = reclassWarnings({ source, target, movable, impact, priorSources });
  const postedThrough = await getLedgerPostedThrough(companyId, window.end, window.start);

  return {
    postingDate: input.postingDate,
    source, target, movable, skipped, universeTotal,
    drafts, impact, warnings, postedThrough,
  };
}
