/**
 * A supplier statement's opening "Balance brought forward" line (Hein, 2026-11-07, D1).
 *
 * It is the supplier's balance before the period's transactions, not an invoice: it is never matched to a bill,
 * never counted missing in IsaFlow, and is compared instead with what IsaFlow owed the supplier the day before
 * the first dated transaction line (supplierStatementMeasure.measureOpeningBalance).
 *
 * Pure and deterministic, so the extraction job, Rematch and every read classify the same stored lines the same
 * way; nothing is persisted for it (supplier_statement_lines.mismatch_reason's CHECK has no value for it, and the
 * line keeps mismatch_reason NULL with no match).
 *
 * A line is the opening balance only when BOTH hold:
 *  - wording: its description or reference, trimmed and whitespace-collapsed, is exactly one of the phrases below
 *    (case-insensitive, trailing "." or ":" allowed); "Invoice 12 brought forward" is not; "c/f" (carried forward,
 *    a closing figure) is not;
 *  - position: it is dated, on or before every dated line that is not so worded. A "Balance brought forward" dated
 *    after a transaction (a page carry-forward) is an ordinary line and is matched like one. Position is by date,
 *    not list order, because the job sees the VLM's order and Rematch/reads see the stored date order.
 */

/** A line's ISO day, or null when it has none (an undated line never qualifies). */
function day(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const OPENING_WORDING =
  /^(?:(?:balance|bal) (?:b\/f|b\/fwd|b\/forward|brought forward)|brought forward|opening balance|b\/fwd|b\/f)[.:]?$/i;

export function isOpeningBalanceWording(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPENING_WORDING.test(text.trim().replace(/\s+/g, ' '));
}

export interface ClassifiableLine {
  date?: string | null;
  reference?: string | null;
  description?: string | null;
}

const worded = (l: ClassifiableLine) => isOpeningBalanceWording(l.description) || isOpeningBalanceWording(l.reference);

/** The earliest date among the dated lines not in `exclude`, or null. */
function firstDate(lines: ClassifiableLine[], exclude: (i: number) => boolean): string | null {
  let first: string | null = null;
  lines.forEach((l, i) => {
    const d = day(l.date);
    if (d && !exclude(i) && (first === null || d < first)) first = d;
  });
  return first;
}

/**
 * Index of the statement's opening-balance line, as a set (empty or one): the ONE worded line on the earliest
 * worded date, when that date is on or before the first dated transaction (or there is none). Two worded lines on
 * that date (a "Balance b/f" and an "Opening balance", or a B/F and a same-day carry-forward) cannot be told apart,
 * because stored lines carry no order within a day, so neither qualifies and both stay visible (fail-safe, never a
 * doubled opening figure). Undated lines cannot be placed and are ignored for position.
 */
export function openingBalanceIndexes(lines: ClassifiableLine[]): Set<number> {
  const earliestWorded = firstDate(lines, (i) => !worded(lines[i]!));
  if (!earliestWorded) return new Set();
  const firstTransaction = firstDate(lines, (i) => worded(lines[i]!));
  if (firstTransaction !== null && earliestWorded > firstTransaction) return new Set();
  const candidates = lines.flatMap((l, i) => (worded(l) && day(l.date) === earliestWorded ? [i] : []));
  return candidates.length === 1 ? new Set(candidates) : new Set();
}

/**
 * The date IsaFlow's side of the opening balance is measured at: the day before the first dated transaction
 * line (the supplier's balance then is its brought-forward figure). With no dated transaction line, the day
 * before the opening line's own date.
 */
export function openingBalanceAsAt(lines: ClassifiableLine[], opening: Set<number>): string {
  // A worded line that did not qualify (a later carry-forward) is not a transaction either.
  const first = firstDate(lines, (i) => worded(lines[i]!)) ?? firstDate(lines, (i) => !opening.has(i));
  if (!first) throw new Error('openingBalanceAsAt needs a dated line');
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The opening line's comparison with what IsaFlow owed the supplier (supplierStatementMeasure.measureOpeningBalance). */
export interface OpeningBalanceCheck {
  /** The day IsaFlow's side is measured at: the day before the first dated transaction line (else the B/F's date). */
  asAt: string;
  /** The statement's brought-forward figure: the opening line's running balance (else its debit less credit). */
  statementAmount: number;
  isaflowBalance: number;
  /** statementAmount − isaflowBalance. */
  variance: number;
}
