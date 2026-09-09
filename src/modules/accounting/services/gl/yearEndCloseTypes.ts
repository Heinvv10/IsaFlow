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

interface CloseYearDryRunBase {
  dryRun: true;
  /** What THIS call read from the ledger — re-read after the closed-year lookup. */
  netIncome: number;
  /**
   * The same residual `CloseYearResult` carries. P&L that landed in the year
   * AFTER its close makes the residual preview non-empty — it is exactly that
   * movement — but the live call will never write it, because the entry number
   * is taken. Zero on an open year.
   */
  unclosedNetIncome: number;
}

/**
 * A dry run either OFFERS a journal or reports one it can never write, and the
 * two are different shapes rather than one shape plus a flag (K-113).
 *
 * The distinction used to live in a doc comment: `preview` was populated on
 * both branches and only the MCP tool nulled it, by hand, under `would_post`.
 * A comment is not a guard — the next consumer reads a balanced, unpostable
 * journal as an offer to post. Here `preview` is `null` by construction the
 * moment `alreadyClosed` is true, and the residual has its own name.
 *
 * A closed year's aggregates are flat — its own closing journal is what
 * flattened them — so `netIncome: 0` with an empty preview is byte-identical to
 * a company that never traded. `alreadyClosed` is what separates them.
 */
export type CloseYearDryRunResult =
  | (CloseYearDryRunBase & {
      alreadyClosed: false;
      existingEntry: null;
      /** The journal the live call WOULD post. */
      preview: YearEndJournalPreview;
      residualPreview?: undefined;
    })
  | (CloseYearDryRunBase & {
      alreadyClosed: true;
      /** The closing journal the year already has. */
      existingEntry: Record<string, unknown>;
      /** Null by construction: no close can write this year again. */
      preview: null;
      /**
       * What is stranded, line by line — NOT an offer. Non-empty only when P&L
       * landed in the year after it closed; `unclosedNetIncome` is the same
       * money as a number.
       */
      residualPreview: YearEndJournalPreview;
    });

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
