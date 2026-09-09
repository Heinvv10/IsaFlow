/**
 * The shapes `closeFiscalYear` answers with.
 *
 * Split out of `yearEndCloseService` to keep it inside the 300-line cap once
 * the dry run gained its residual. Types only — no behaviour lives here, and
 * `yearEndCloseService` re-exports every name, so existing importers are
 * unaffected.
 */

export interface YearEndJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface YearEndJournalPreview {
  /** The year's last day — where the closing journal lands. */
  entryDate: string;
  entryNumber: string;
  description: string;
  lines: YearEndJournalLine[];
  totalDebit: number;
  totalCredit: number;
}

export interface CloseYearResult {
  /**
   * NULL for a year with nothing to close. A dormant year — no posted P&L
   * movement at all — has an empty journal, and an empty journal is not a
   * legal one to write. The year still CLOSES: every period is locked, which
   * is the part callers act on. `periodsLockedInYear` says so without making
   * them read the null.
   */
  closingEntry: Record<string, unknown> | null;
  /**
   * How many periods carry `locked` for this year — counted, never assumed, and
   * NOT "locked by this call". On a close that wrote they are the same number;
   * on an already-closed re-run this is the twelve an earlier close locked and
   * this call locked none. Named for the meaning it actually has, because a
   * consumer reading it as this call's work is told a no-op locked twelve.
   */
  periodsLockedInYear: number;
  /** True when the year already had a posted closing journal and nothing was written. */
  alreadyClosed: boolean;
  netIncome: number;
  /**
   * P&L posted INSIDE an already-closed year that is NOT in its closing journal
   * — zero on every other path. Nothing stops a posted journal landing in a
   * locked year, and once one does the entry number is taken, so this service
   * can never sweep it into equity. See `alreadyClosedResult`.
   */
  unclosedNetIncome: number;
  message: string;
}

export interface CloseYearDryRunResult {
  dryRun: true;
  netIncome: number;
  preview: YearEndJournalPreview;
  /**
   * True when the year already has a posted closing journal (K-113).
   *
   * A closed year's aggregates are flat — its own closing journal is what
   * flattened them — so `netIncome: 0` with an EMPTY preview is exactly what a
   * company that never traded returns. The dry run is the read a person makes
   * before authorising the irreversible half, and telling them a year that
   * traded and was closed is empty is a false statement about the books.
   */
  alreadyClosed: boolean;
  /** The existing closing journal, when `alreadyClosed`. */
  existingEntry: Record<string, unknown> | null;
  /**
   * The same residual `CloseYearResult` carries, and the reason the preview of
   * an already-closed year is NOT an offer to post. P&L that landed in the year
   * after its close makes the preview non-empty — it is exactly that movement —
   * but the live call will never write it, because the entry number is taken.
   * A dry run that showed the journal without this number would authorise a
   * posting that cannot happen.
   */
  unclosedNetIncome: number;
}

export type CloseYearError =
  | { error: 'open_periods'; count: number; openPeriods: Array<{ id: string; periodName: string; periodNumber: number }> }
  | { error: 'year_not_found' }
  | { error: 'no_retained_earnings' }
  | { error: 'ambiguous_retained_earnings'; accountCodes: string[] }
  | { error: 'no_fiscal_period'; entryDate: string }
  | {
      /**
       * The year has a `year_end` header that is NOT posted — reversed, or left
       * in draft. The year is not closed, and it also cannot be closed while
       * that row holds the entry number.
       */
      error: 'closing_journal_not_posted';
      entryNumber: string;
      entryId: string;
      status: string;
    }
  | {
      /**
       * A journal that is NOT a year-end close already carries `YE-<year>`.
       * `uq_gl_je_company_entry_number` has no source predicate, so the year is
       * unclosable until that row is renumbered.
       */
      error: 'closing_entry_number_taken';
      entryNumber: string;
      entryId: string;
      source: string;
      status: string;
    }
  | {
      error: 'period_range_mismatch';
      expected: { startDate: string; endDate: string };
      actual: { startDate: string; endDate: string };
      startMonth: number;
    };

export interface CloseYearOptions {
  /** Run every guard and return the journal, writing nothing. */
  dryRun?: boolean;
}
