/**
 * The shared response envelope for every list-returning MCP report.
 *
 * WHY THIS EXISTS. `aged_debtors` returned exactly ten customer rows totalling
 * R63.1m with no total, no row count and no truncation flag. Ten is a
 * suspiciously round number to a human and an unremarkable one to an agent — the
 * response gave a caller no way to establish whether it was looking at the book
 * or at the first page of it. A figure whose completeness cannot be established
 * cannot be relied on, and an agent has no instinct that says "ten is
 * suspicious". So completeness is not a feature of some reports here; it is the
 * shape of all of them, and a report that cannot fill these fields honestly is
 * not finished.
 *
 * Field naming mixes camelCase with the snake_case `next_cursor` and `as_at`.
 * That is deliberate and matches the specification of 2026-09-03: the snake_case
 * names are the ones that also appear as tool ARGUMENTS, and a cursor that is
 * read back under a different name than it is sent under is a papercut every
 * caller pays. Do not "tidy" this.
 */

/**
 * How much a report should return.
 *
 * - `summary`  — totals and completeness only; `rows` is empty BY DESIGN.
 * - `standard` — one row per reporting entity (the default).
 * - `full`     — rows plus their underlying transactions. ALWAYS paginated.
 *
 * `vat_status` returns 67KB and exceeds the response limit because it has one
 * mode and it is the largest one. Every report gets three.
 */
export type DetailLevel = 'summary' | 'standard' | 'full';

export const DETAIL_LEVELS: readonly DetailLevel[] = ['summary', 'standard', 'full'];

export function isDetailLevel(value: unknown): value is DetailLevel {
  return typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value);
}

/**
 * A row the report could not classify, and therefore did not include in its
 * totals.
 *
 * A customer invoice with a null due date currently disappears from the aged
 * debtors report with no error — R1,058,000 of a R1,429,774 reconciling
 * difference was one such row. Silently dropping it is the defect. Naming it
 * here is the fix: the caller sees a total it can trust AND the rows that total
 * excludes, and can decide what to do about them.
 *
 * `reason` is a machine-stable code (`null_due_date`, `no_control_account`,
 * `unmapped_vat_treatment`), not prose — callers branch on it. Put the prose in
 * `detail`. `amount` is optional but should be supplied whenever the row has
 * one, because "three rows were excluded" and "R1.06m was excluded" are
 * different facts and only the second one tells a reader whether to care.
 */
export interface ExcludedRow {
  /** Primary key of the excluded record, so the caller can go and look at it. */
  id: string;
  /** Machine-stable code. snake_case, stable across releases. */
  reason: string;
  /** Human-readable explanation. Optional; never parsed. */
  detail?: string;
  /** The value withheld from the totals, when the row has one. */
  amount?: number;
  /** Invoice/journal number where one exists — ids alone are hard to chase. */
  documentNumber?: string;
}

/**
 * Every list-returning report returns this. No exceptions, no per-report
 * variations.
 */
export interface ReportEnvelope<TRow> {
  /** The page. Empty when `detail` is `summary`. */
  rows: TRow[];
  /** `rows.length`. Present so a caller need not compute it to compare. */
  rowsReturned: number;
  /**
   * How many rows the report has IN TOTAL, before paging — not how many were
   * served. This is the number that makes ten rows either the whole book or the
   * first page of it. It counts rows the report INCLUDED; excluded rows are
   * counted separately in `excludedRows`.
   */
  rowsTotal: number;
  /** `rowsReturned < rowsTotal`. Derived, but returned so nobody re-derives it wrongly. */
  truncated: boolean;
  /** Opaque keyset cursor for the next page, or null when this is the last one. */
  next_cursor: string | null;
  /** Rows the report could not classify. Empty array, never omitted. */
  excludedRows: ExcludedRow[];
  /** The detail level actually applied (which may be the default, not the one asked for). */
  detail: DetailLevel;
  /**
   * The reporting date, YYYY-MM-DD. For a range report this is the END of the
   * range; the range itself belongs in the report's own fields.
   */
  as_at: string;
  /**
   * The latest ledger write included in this figure, as an ISO-8601 timestamp.
   *
   * This is what makes a number re-derivable. A trial balance signed on
   * 3 September and re-run on 10 September will differ if anyone back-dated a
   * journal in between, and today nothing in the API lets a reader tell that
   * from an arithmetic error. `posted_through` pins it: same `as_at`, same
   * `posted_through`, same numbers, or there is a bug.
   *
   * It is the MAX(created_at) of the rows the figure consumed — NOT `now()`,
   * which would change on every call and prove nothing.
   */
  posted_through: string;
  /**
   * Which definition produced the figures — e.g. `ar.outstanding.v1`.
   *
   * Cash has four answers across the dashboard, the balance sheet, the cash flow
   * and reality, and AR has four. That is four implementations, not four bugs.
   * Naming the definition in the response makes a disagreement impossible to
   * mistake for a rounding difference, and is the contract between this envelope
   * and the shared figure service.
   */
  figureBasis?: string;
}

export interface BuildEnvelopeInput<TRow> {
  rows: TRow[];
  rowsTotal: number;
  detail: DetailLevel;
  as_at: string;
  posted_through: string;
  next_cursor?: string | null;
  excludedRows?: ExcludedRow[];
  figureBasis?: string;
}

/**
 * Builds an envelope with `rowsReturned` and `truncated` derived, so that no
 * report can report its own completeness inconsistently.
 *
 * Throws when `rowsTotal` is less than the rows served: that state means the
 * count query and the page query disagree, which is exactly the class of bug
 * this envelope exists to expose. Failing loudly beats serving a report that
 * claims to be complete and is not.
 */
export function buildEnvelope<TRow>(input: BuildEnvelopeInput<TRow>): ReportEnvelope<TRow> {
  const rowsReturned = input.rows.length;
  if (input.rowsTotal < rowsReturned) {
    throw new Error(
      `rowsTotal (${input.rowsTotal}) is below rowsReturned (${rowsReturned}) — the count and page queries disagree`,
    );
  }
  if (input.detail === 'summary' && rowsReturned > 0) {
    throw new Error('detail "summary" must return no rows');
  }
  return {
    rows: input.rows,
    rowsReturned,
    rowsTotal: input.rowsTotal,
    // A summary deliberately serves no rows, so it is never "truncated" — the
    // caller asked for totals and got all of them.
    truncated: input.detail === 'summary' ? false : rowsReturned < input.rowsTotal,
    next_cursor: input.next_cursor ?? null,
    excludedRows: input.excludedRows ?? [],
    detail: input.detail,
    as_at: input.as_at,
    posted_through: input.posted_through,
    ...(input.figureBasis === undefined ? {} : { figureBasis: input.figureBasis }),
  };
}
