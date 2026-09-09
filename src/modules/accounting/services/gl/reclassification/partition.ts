/**
 * WHICH posted lines a reclassification may move, and why each of the rest may
 * not — the decision, with no database in it.
 *
 * PURE, and separate from the query in ./candidates.ts for the reason
 * `bulkAllocationSkip` is: the dry run and the live call must reach the same
 * verdict from the same read, or a dry run that passes where the real call
 * refuses is worse than no dry run at all. Every guard is therefore testable
 * without a fixture, and the guards are the whole safety surface.
 *
 * A reclassification does NOT rewrite the lines it selects. It reads them so it
 * can post a NEW journal that contras the source account and re-applies the
 * amount to the target — see ./journals.ts. Nothing in this module updates
 * `gl_journal_lines.gl_account_id`, and nothing should: rewriting posted
 * history silently changes a trial balance somebody may already have signed,
 * and leaves an auditor with no way to see the original classification.
 */

import type { VatType } from '../../../types/gl.types';

/**
 * `gl_journal_lines.vat_type` is a bare `text` column with no CHECK, so a
 * stored value is not guaranteed to be a `VatType`. A line whose coding this
 * list does not recognise is SKIPPED rather than posted with the coding
 * dropped — the same rule as `cc1_id`. Production carries only 'standard' and
 * 'exempt' today.
 */
const KNOWN_VAT_TYPES: readonly string[] = [
  'standard', 'zero_rated', 'exempt', 'capital_goods', 'export',
  'imported', 'reverse_charge', 'bad_debt', 'no_vat',
];

/** One posted line on the source account, with everything the guards need. */
export interface CandidateRow {
  line_id: string;
  journal_entry_id: string;
  entry_number: string | null;
  entry_date: string;
  debit: string | number | null;
  credit: string | number | null;
  description: string | null;
  project_id: string | null;
  cost_center_id: string | null;
  /** The ENTRY carries a reversal; its lines have already been contra'd. */
  reversed: boolean;
  /**
   * The ENTRY *is* a reversal — it carries `reversal_of_id`, so it is the
   * contra half of a pair whose other half has `reversed_at` set.
   */
  is_reversal_leg: boolean;
  /** VAT coding on the line itself. NULL means it contributes to no VAT box. */
  vat_type: string | null;
  bu_id: string | null;
  /** Analysis dimensions `JournalLineInput` cannot express — see the skip. */
  cc1_id: string | null;
  cc2_id: string | null;
  /** `open` / `closed` / `locked`, or null when no period covers the entry. */
  period_status: string | null;
  has_period: boolean;
  /** A live earlier batch already moved this line. */
  already_reclassified: boolean;
  /** This line IS the contra leg an earlier reclassification posted. */
  is_reclass_contra: boolean;
  /** The entry date falls inside a filed VAT period. */
  vat_period_locked: boolean;
}

/** A line that WILL move, in the shape the journal builder consumes. */
export interface ReclassCandidate {
  lineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  debit: number;
  credit: number;
  description: string | null;
  projectId: string | null;
  costCenterId: string | null;
  /** Carried onto BOTH legs, like every other dimension on the line. */
  vatType: VatType | null;
  buId: string | null;
}

/** A line that will NOT move, and the machine-stable reason. */
export interface ReclassSkip {
  lineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  amount: number;
  reason: ReclassSkipReason;
}

export type ReclassSkipReason =
  | 'entry_reversed'
  | 'entry_is_reversal'
  | 'appeared_after_lock'
  | 'unreproducible_analysis_coding'
  | 'unknown_vat_type'
  | 'already_reclassified'
  | 'reclassification_contra'
  | 'zero_amount'
  | 'vat_period_locked'
  | 'source_period_closed'
  | 'source_period_missing';

export interface PartitionOptions {
  /**
   * The lines this batch actually holds a row lock on, or `undefined` on a
   * read-only path that took none.
   *
   * A line that appeared on the source account BETWEEN the lock and the re-read
   * is not in this set. It is real and it is a candidate, so it stays in the
   * universe and is reported — but it is not locked, so moving it would
   * reintroduce the very race the lock closes. It is skipped, not dropped:
   * dropping it would leave `rowsTotal + excluded` short of `universeTotal` and
   * raise a completeness fault whose stated cause would be wrong.
   */
  lockedLineIds?: ReadonlySet<string>;
  /**
   * When set, every reclassification journal is dated HERE instead of at its
   * source line's own date — so the source line's period being closed no longer
   * bars the move, because that period is not being written to. The caller
   * validates this date's own period before it gets here.
   */
  postingDate: string | null;
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The reasons are ORDERED, and the order is the message the caller gets. A line
 * on a reversed entry in a closed period is reported as reversed, because that
 * is the fact a human needs first: re-opening the period would not make it
 * movable.
 */
function skipReasonFor(row: CandidateRow, opts: PartitionOptions): ReclassSkipReason | null {
  // Checked FIRST: an unlocked row's other state was read outside the lock, so
  // no verdict about it is trustworthy enough to report as the reason.
  if (opts.lockedLineIds !== undefined && !opts.lockedLineIds.has(row.line_id)) {
    return 'appeared_after_lock';
  }
  if (row.reversed) return 'entry_reversed';
  // A REVERSAL IS A PAIR, AND THIS TOOL MUST SEE BOTH HALVES OF IT.
  //
  // `reversed_at` marks the entry that WAS reversed; `reversal_of_id` marks the
  // entry that DID the reversing. They mirror each other line for line on the
  // same account, so together they net to zero. Skipping only the first tears
  // the pair apart: the original charge stays on the source account and its
  // cancellation is carried to the target, and NEITHER account nets to zero
  // afterwards. On the live Velocity books that is 39 lines and R15,477,616.91
  // on `49775626` and 5 lines and R407,422.11 on `49775627` — and the
  // before/after P&L cannot see it, because both accounts report in the same
  // band and every band total is unchanged.
  //
  // BOTH HALVES ARE SKIPPED, not both moved. The pair contributes nothing to
  // any balance, so leaving it where it is changes no figure, while moving it
  // would post two more journals to relocate a nil. Reclassifying a reversed
  // charge is a different intent from reclassifying a live one, and a tool that
  // silently folded it in would be deciding that for the operator. Its own
  // reason code says which half was seen.
  if (row.is_reversal_leg) return 'entry_is_reversal';
  if (row.is_reclass_contra) return 'reclassification_contra';
  if (row.already_reclassified) return 'already_reclassified';
  if (num(row.debit) === 0 && num(row.credit) === 0) return 'zero_amount';
  // The shared journal writer supports CC1/CC2, but this module's source-line
  // mapping and journal builder do not yet carry them. Keep skipping such lines
  // until the complete reclassification workflow preserves their attribution.
  if (row.cc1_id !== null || row.cc2_id !== null) return 'unreproducible_analysis_coding';
  if (row.vat_type !== null && !KNOWN_VAT_TYPES.includes(row.vat_type)) return 'unknown_vat_type';
  // A filed VAT period binds a line that CARRIES VAT CODING — that line is
  // anchored to a return already sent to SARS. A line with no `vat_type`
  // contributes to no box and is unaffected. (The account-level question — a
  // move onto a VAT control account — is refused outright by `plan.ts`, which
  // is why it is not a skip here.)
  if (row.vat_type !== null && row.vat_period_locked) return 'vat_period_locked';
  // Both of these are about writing INTO the source line's own period, so both
  // fall away once the caller names a posting date of its own.
  if (opts.postingDate === null) {
    if (!row.has_period) return 'source_period_missing';
    if (row.period_status !== 'open') return 'source_period_closed';
  }
  return null;
}

export interface Partitioned {
  movable: ReclassCandidate[];
  skipped: ReclassSkip[];
}

/**
 * Every candidate lands in exactly one of the two lists. That identity is what
 * `propose_reclassification` reports to `buildEnvelope`, and it is checkable
 * only because nothing here filters silently.
 */
export function partitionCandidates(
  rows: readonly CandidateRow[],
  opts: PartitionOptions,
): Partitioned {
  const movable: ReclassCandidate[] = [];
  const skipped: ReclassSkip[] = [];

  for (const row of rows) {
    const reason = skipReasonFor(row, opts);
    if (reason !== null) {
      skipped.push({
        lineId: row.line_id,
        journalEntryId: row.journal_entry_id,
        entryNumber: row.entry_number,
        entryDate: row.entry_date,
        // The amount is the fact that tells a reader whether to care: "three
        // lines were skipped" and "R1.06m was skipped" are different findings.
        amount: num(row.debit) - num(row.credit),
        reason,
      });
      continue;
    }
    movable.push({
      lineId: row.line_id,
      journalEntryId: row.journal_entry_id,
      entryNumber: row.entry_number,
      entryDate: row.entry_date,
      debit: num(row.debit),
      credit: num(row.credit),
      description: row.description,
      projectId: row.project_id,
      costCenterId: row.cost_center_id,
      // Narrowed by the guard above: an unrecognised value never reaches here.
      vatType: row.vat_type as VatType | null,
      buId: row.bu_id,
    });
  }

  return { movable, skipped };
}
