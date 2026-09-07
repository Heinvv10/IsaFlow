/**
 * WHICH of the matters page 11 actually prints, and what it says about the
 * rest.
 *
 * `buildMatters` returns one row per finding, and the live ISAFlow Demo
 * company produces twenty-eight of them — twenty-six unusual journals and two
 * overdue statutory filings. Twenty-eight rows of two-line prose is 344mm of
 * table on a 255mm sheet, so the page printed on three sheets: the pack's
 * twelve-page contract, and a director's expectation that a numbered page is
 * a page, both broken by a company whose ledger happened to be busy.
 *
 * A board pack has one honest answer to more matters than fit: print the ones
 * that matter most and SAY how many were not printed, with what they come to.
 * Silently truncating a list of things a board must decide on would be the
 * worse defect of the two — spec §7.1 criterion 3's rule, that an empty result
 * is never an empty page, read in the other direction.
 *
 * THE CAP IS NOT PURELY BY QUANTUM. `buildMatters` ranks by rand exposure and
 * treats a null quantum as zero, which puts "Annual Financial Statements for
 * FY2024 is 739 days overdue" LAST — behind a R400 journal. A statutory
 * filing two years overdue is the single most board-relevant thing the check
 * produces and it has no rand amount by nature, so every quantified-as-null
 * matter is printed regardless of where the ranking put it; the rest of the
 * page is filled by exposure, largest first.
 */
import type { PackMatter } from './packMatters';

/**
 * How many matters one sheet holds.
 *
 * Measured, not chosen: a matter's issue text wraps to two lines at the
 * printed width and up to three for the longest `buildMatters` produces, so a
 * row is 12-16mm. The page also carries a title, the matters commentary, the
 * "What was checked" disclosure and the repeated-column note — about 70mm —
 * inside a 255mm content box. Ten rows fit at the three-line worst case with
 * room to spare; twelve do not. Proved on the printed sheet by
 * tests/unit/print/packSheetCount.test.ts, against the live demo company's
 * own twenty-eight.
 */
export const MATTERS_PRINTED_MAX = 10;

export interface SelectedMatters {
  /** The matters the page prints, in the order `buildMatters` ranked them. */
  printed: PackMatter[];
  /** The rest, so the page can state how many and what they come to. */
  omitted: PackMatter[];
}

export function selectPrintedMatters(
  matters: PackMatter[],
  max: number = MATTERS_PRINTED_MAX,
): SelectedMatters {
  if (matters.length <= max) return { printed: matters, omitted: [] };

  // Never dropped: a matter with no rand amount is a filing, a failed check or
  // the "no matters" note, and the quantum ranking buries all three.
  const keep = new Set(matters.filter((m) => m.quantum === null));

  for (const matter of [...matters]
    .filter((m) => m.quantum !== null)
    .sort((a, b) => Math.abs(b.quantum as number) - Math.abs(a.quantum as number))) {
    if (keep.size >= max) break;
    keep.add(matter);
  }

  return {
    printed: matters.filter((m) => keep.has(m)),
    omitted: matters.filter((m) => !keep.has(m)),
  };
}

/** What the omitted matters come to, for the note under the table. Null when
 *  none of them carries a rand amount — a count with no total, rather than a
 *  zero that would read as "worth nothing". */
export function omittedQuantum(omitted: PackMatter[]): number | null {
  const quantified = omitted.filter((m): m is PackMatter & { quantum: number } => m.quantum !== null);
  if (quantified.length === 0) return null;
  return quantified.reduce((sum, m) => sum + m.quantum, 0);
}
