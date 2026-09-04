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
}

export interface ReclassPlan {
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

/** Subtypes on which a filed VAT return actually depends. */
const VAT_SUBTYPES = new Set(['vat_input', 'vat_output']);

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

  const vatRelevant =
    (source.subtype !== null && VAT_SUBTYPES.has(source.subtype)) ||
    (target.subtype !== null && VAT_SUBTYPES.has(target.subtype));

  // A move onto a VAT control account inside a filed period rewrites a return
  // that has gone to SARS. Refused at the posting date; skipped per line at the
  // source dates (see `partitionCandidates`).
  if (vatRelevant && input.postingDate !== null
      && (await isVatPeriodLocked(companyId, input.postingDate))) {
    return {
      refused:
        `posting_date ${input.postingDate} falls inside a filed VAT period and this ` +
        'move touches a VAT control account.',
    };
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

  const { movable, skipped } = partitionCandidates(rows, {
    postingDate: input.postingDate,
    vatRelevant,
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
    source, target, movable, skipped, universeTotal,
    drafts, impact, warnings, postedThrough,
  };
}
