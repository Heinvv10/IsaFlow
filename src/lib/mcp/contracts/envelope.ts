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
  /**
   * Set when the report's own numbers do not add up — the count query and the
   * page query disagree, or the classified rows plus the excluded rows do not
   * account for the universe the report drew from.
   *
   * This is NOT thrown, deliberately. A read tool runs with no savepoint
   * (`src/lib/mcp/.claude.md`), so a throw after the query has run aborts the
   * whole request transaction; the registry's own refund and audit writes then
   * fail with 25P02 and the caller gets a 500 with the Flow debit unrefunded.
   * The module already eliminated that failure mode once, by validating casts
   * BEFORE the query — reintroducing it here, after the query, would undo that.
   *
   * It is also the better answer on the merits. "This report cannot account for
   * all of its rows" is an assurance finding and belongs in front of the reader,
   * not converted into an HTTP error that tells them nothing. Absent means the
   * arithmetic held.
   */
  completenessFault?: string;
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
  /**
   * How many candidate rows the report drew from BEFORE any classification
   * filter — the unfiltered universe.
   *
   * This is what turns the envelope from a self-report into a checkable claim.
   * Without it, a report can compute both its COUNT and its page with
   * `WHERE due_date IS NOT NULL`, forget to collect the excluded rows, and hand
   * over rowsTotal 10 / excludedRows [] — internally consistent, and the exact
   * R1,058,000 aged-debtors bug this contract exists to prevent, now wearing a
   * shape that looks verified.
   *
   * With it, `rowsTotal + excludedRows.length === universeTotal` is arithmetic
   * the envelope can check on the report's behalf. REQUIRED on every assurance
   * report; omit it only on a listing where completeness is not a claim.
   */
  universeTotal?: number;
}

/**
 * Builds an envelope with `rowsReturned` and `truncated` derived, so that no
 * report can state its own completeness inconsistently.
 *
 * NEVER THROWS. Every inconsistency is recorded in `completenessFault` and the
 * report is still returned — see the field's own note for why an exception is
 * the wrong instrument here. Use `assertEnvelopeSound` in tests to turn a fault
 * into a failure at the only point where failing is free.
 */
export function buildEnvelope<TRow>(input: BuildEnvelopeInput<TRow>): ReportEnvelope<TRow> {
  const faults: string[] = [];
  let rows = input.rows;
  let rowsTotal = input.rowsTotal;
  const excludedRows = input.excludedRows ?? [];

  // A summary serves totals, not rows. Serving rows anyway is a coding error in
  // the report; drop them rather than let a caller that asked for a summary
  // silently receive an unpaginated page.
  if (input.detail === 'summary' && rows.length > 0) {
    faults.push(`detail "summary" returned ${rows.length} rows; dropped`);
    rows = [];
  }

  // The count query and the page query disagree. Serving rowsTotal as-is would
  // make `truncated` nonsense, so raise it to what was actually served and say
  // so — an understated total reads as "this is the whole book" and is the more
  // dangerous of the two errors.
  if (rowsTotal < rows.length) {
    faults.push(
      `rowsTotal (${rowsTotal}) is below rowsReturned (${rows.length}) — the count and page queries disagree`,
    );
    rowsTotal = rows.length;
  }

  // The identity that makes completeness checkable rather than merely asserted.
  if (input.universeTotal !== undefined) {
    const accounted = rowsTotal + excludedRows.length;
    if (accounted !== input.universeTotal) {
      faults.push(
        `${accounted} rows accounted for (${rowsTotal} included + ${excludedRows.length} excluded) against a universe of ${input.universeTotal} — ${Math.abs(input.universeTotal - accounted)} unaccounted`,
      );
    }
  }

  const rowsReturned = rows.length;
  return {
    rows,
    rowsReturned,
    rowsTotal,
    // A summary deliberately serves no rows, so it is never "truncated" — the
    // caller asked for totals and got all of them.
    truncated: input.detail === 'summary' ? false : rowsReturned < rowsTotal,
    next_cursor: input.next_cursor ?? null,
    excludedRows,
    detail: input.detail,
    as_at: input.as_at,
    posted_through: input.posted_through,
    ...(input.figureBasis === undefined ? {} : { figureBasis: input.figureBasis }),
    ...(faults.length === 0 ? {} : { completenessFault: faults.join('; ') }),
  };
}

/**
 * Throws when an envelope carries a completeness fault. FOR TESTS.
 *
 * The invariant is still worth enforcing — it is simply enforced where a
 * failure costs nothing, rather than inside a request that has already spent a
 * Flow debit and holds an open transaction.
 */
export function assertEnvelopeSound(envelope: ReportEnvelope<unknown>): void {
  if (envelope.completenessFault) {
    throw new Error(`envelope completeness fault: ${envelope.completenessFault}`);
  }
}
