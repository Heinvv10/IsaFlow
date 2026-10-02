/**
 * Page 11 — the matters requiring board attention.
 *
 * This is the page a board pack exists for: the issues a director has to
 * decide on, not the numbers everyone can already read on the statements.
 * Spec §4.A names four sources — aged debtor concentration, unreconciled
 * bank items, unusual journals, overdue statutory filings — ranked by
 * quantum, largest first.
 *
 * The rule this file exists to enforce: a source that fails becomes a NAMED
 * matter, never a silent omission. A board pack that claims to check aged
 * debtors and quietly drops the section because a query timed out is worse
 * than one that says the check failed — a reader sees an empty page as
 * "nothing to worry about", which is the one conclusion a failed check has
 * not earned. Spec §7.1 criterion 3 is symmetric with this: an empty result
 * is also never an empty page — it is an explicit "no matters" item.
 *
 * "Movement since last meeting" is spec'd per matter, but nothing in this
 * codebase persists what a prior board pack said, so there is no baseline to
 * diff against. Every matter states that honestly rather than fabricating a
 * trend; see the task report for why inventing one would fail the same test
 * this file exists to pass.
 */

import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { isFailedRead } from '@/modules/accounting/services/packs/packFailedRead';
import { FilingDeadlineUnknownError } from '@/modules/accounting/services/reports/statutoryFilingsService';
import { BOARD_DECISIONS } from './packMatterDecisions';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';
import { NO_PRIOR_MEETING_RECORD, SOURCES } from './packMatterSources';

export { NO_PRIOR_MEETING_RECORD, SOURCES } from './packMatterSources';

/**
 * WHAT KIND OF LINE THIS IS, as data rather than as a sentence to re-parse.
 *
 * Page 11's title has to state a conclusion about the period — how many
 * matters are open and what they come to — and "no matters this period" is a
 * `PackMatter` too, as is "this check could not be run". Deriving that from
 * the issue text would make the page's headline depend on a string match
 * against prose the next author is free to reword.
 */
export type PackMatterKind =
  /** A real finding: a concentration, an unreconciled balance, a journal, a filing. */
  | 'finding'
  /** The explicit "every check ran clean" line (§7.1 criterion 3). */
  | 'none'
  /** A source that threw. It is a matter precisely because it is not a clean result. */
  | 'checkFailed';

/** One line of page 11 — a decision a director must make. */
export interface PackMatter {
  kind: PackMatterKind;
  issue: string;
  /** Rand value behind the matter. Null for a matter with no single amount
   *  (a filing overdue, or the "no matters" / "check failed" fallbacks).
   *  Ranking treats null as zero. */
  quantum: number | null;
  owner: string;
  /** Movement since the last board meeting — see the file header for why
   *  this is always the same honest statement rather than a computed trend. */
  movement: string;
  decisionRequired: string;
}

/** Everything page 11 needs from the ledger: its matters, and the aged
 *  debtors total page 11's own reconciliation note is taken against. */
export interface PackMattersRead {
  matters: PackMatter[];
  /** Null where no aged-debtors total is printed anywhere in the pack — in
   *  which case there is no contradiction on the paper to reconcile. */
  agedDebtorsTotal: number | null;
  /** The full open AR subledger. Null only where the aging report could not
   *  be read at all, in which case the check is already a named matter. */
  subledgerTotal: number | null;
}

/**
 * What a swallowed exception is allowed to say in the log: its class and, for
 * a Postgres error, its SQLSTATE. Never its message — see the call site.
 */
function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `${error.name} (SQLSTATE ${code})`
    : error.name;
}

/**
 * A FAILED CHECK IS A MATTER, AND THE EXCEPTION IS NOT PART OF IT.
 *
 * The matter still appears — that is this file's whole rule, and it is why
 * the pack cannot present a timed-out query as a clean page. What came off is
 * `String(error)`, which put a driver's message, and whatever a database
 * chooses to put in one, into the issue column of a document a director
 * forwards to their bank. The reader's decision is the same either way: re-run
 * the check. The exception is logged, where the person who can act on it
 * looks.
 */
function failedSourceMatter(label: string): PackMatter {
  return {
    kind: 'checkFailed',
    issue: `${label} could not be assessed — the check failed and was not silently skipped`,
    quantum: null,
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: BOARD_DECISIONS.checkFailed,
  };
}

// NOT IN `BOARD_DECISIONS`, deliberately — see that module: this row says
// there is nothing to decide, and phrasing that as a decision would invent one.
const NO_MATTERS: PackMatter = {
  kind: 'none',
  issue: 'No matters require board attention this period — every check ran clean.',
  quantum: null,
  owner: 'Finance',
  movement: NO_PRIOR_MEETING_RECORD,
  decisionRequired: 'None. Note for the record.',
};

export async function buildMatters(
  companyId: string,
  window: PeriodWindow,
): Promise<PackMattersRead> {
  const matters: PackMatter[] = [];
  let agedDebtorsTotal: number | null = null;
  let subledgerTotal: number | null = null;

  // Sequential, not Promise.all — `sql` in @/lib/neon routes every query
  // through the ONE request-scoped pg connection held in the async-local
  // store (see packFigureSet.ts for the same discipline and its reason).
  //
  // AND EACH IN ITS OWN SAVEPOINT. A source that fails aborts that one
  // transaction, and catching the error does not un-abort it: every source
  // after it was refused with 25P02 and became a failed check of its own.
  for (const [index, source] of SOURCES.entries()) {
    try {
      const result = await withSavepoint(`pack_matter_source_${index}`, () =>
        source.build(companyId, window));
      matters.push(...result.matters);
      if (result.agedDebtorsTotal !== undefined) agedDebtorsTotal = result.agedDebtorsTotal;
      if (result.subledgerTotal !== undefined) subledgerTotal = result.subledgerTotal;
    } catch (error) {
      // ONLY A CHECK THAT COULD NOT BE RUN IS A FAILED CHECK: the database
      // refusing the read, or the filings source refusing to date a deadline
      // for a company with no usable financial year start. Anything else is a
      // defect in this code, and a defect printed as "re-run the check" is a
      // board being asked to act on a bug.
      if (!isFailedRead(error) && !(error instanceof FilingDeadlineUnknownError)) throw error;
      // NOT `String(error)`, WHICH IS THE DRIVER'S OWN SENTENCE. A
      // node-postgres message carries whatever the server put in it —
      // "duplicate key value violates unique constraint … Key (email)=(…)"
      // is a real one — so the free text is a tenant's data in a log line
      // that outlives the request. The class and the SQLSTATE are what
      // triage actually reads, and `source.label` is the stable identifier
      // that says WHICH check failed.
      log.warn(
        'packMatters: source failed, recorded as a named matter rather than omitted',
        { companyId, source: source.label, error: errorClass(error) },
        'packs',
      );
      matters.push(failedSourceMatter(source.label));
    }
  }

  if (matters.length === 0) return { matters: [NO_MATTERS], agedDebtorsTotal, subledgerTotal };

  return {
    matters: matters.sort((a, b) => Math.abs(b.quantum ?? 0) - Math.abs(a.quantum ?? 0)),
    agedDebtorsTotal,
    subledgerTotal,
  };
}
