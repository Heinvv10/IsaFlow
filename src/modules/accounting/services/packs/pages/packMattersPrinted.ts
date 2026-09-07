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
 * THE ORDER IS NOT PURELY BY QUANTUM. `buildMatters` ranks by rand exposure
 * and treats a null quantum as zero, which puts "Annual Financial Statements
 * for FY2024 is 739 days overdue" LAST — behind a R400 journal. A statutory
 * filing two years overdue is the single most board-relevant thing the check
 * produces and it has no rand amount by nature, so quantified-as-null matters
 * lead the ranking; the rest of the page is filled by exposure, largest
 * first. They lead it — they do not bypass the budget below, which is the
 * distinction that made the previous cap not a cap.
 */
import type { PackMatter } from './packMatters';

/**
 * THE BUDGET IS IN PRINTED LINES, NOT IN ROWS.
 *
 * It was `MATTERS_PRINTED_MAX = 10`, and ten was measured — once, against one
 * company's twenty-eight matters. It is the wrong instrument twice over. It
 * was not a cap at all (every null-quantum matter was kept BEFORE the count
 * was consulted, so twenty filings printed twenty rows), and even honoured it
 * says nothing about how much paper ten rows take: a reviewer printed twenty
 * long null-quantum matters at FOURTEEN sheets and twenty-six short ones at
 * thirteen, through the harness, at HEAD. `getOverdueStatutoryFilings` has no
 * `LIMIT` and no `DISTINCT` on fiscal year, so a company with several draft
 * AFS documents across several years reaches both shapes on its own — and
 * nothing in the live route counts sheets, so it reaches a director as a
 * fourteen-page document whose contents page indexes twelve and whose footer
 * numbers every sheet `n / 12`.
 *
 * A row's cost is its longest cell, wrapped. So the composer measures the
 * table it is about to print — including which prose columns collapse, which
 * depends on the rows chosen and therefore has to be re-measured as the set
 * grows — and stops at the budget. The sheet count stops depending on an
 * input distribution nobody sampled.
 */

/**
 * The table's own text width, in characters of the printed face.
 *
 * `.pack-matters` runs the full content box: A4 less the 18mm side margins is
 * 174mm, and the table's 8pt sans averages about 1.85mm per character across
 * this prose, so ~94 characters span the table. Cell padding and the column
 * rules take the rest.
 */
const TABLE_CHARS = 88;
/** The quantum column is numeric and narrow — "Quantum (R'000)" is its widest
 *  cell. Taken off the top before the prose columns share what is left. */
const QUANTUM_CHARS = 15;
/** The issue column carries the matter itself and is set wider than the prose
 *  columns beside it; this is its share when the shares are divided. */
const ISSUE_SHARE = 2;

/**
 * What a row costs beyond its text, as a fraction of a line.
 *
 * Cell padding and the rule under each row, which a wrapped-character count
 * cannot see and which dominate a table of ONE-line rows: twenty-six short
 * matters and twelve long ones overflowed by very different amounts under a
 * model that counted only text, and this is the term that reconciles them.
 */
const ROW_OVERHEAD_LINES = 0.5;

/** Lines a string of `text` takes in a column `chars` wide. At least one: an
 *  empty cell is still a row. */
function wrappedLines(text: string, chars: number): number {
  return Math.max(1, Math.ceil(text.length / chars));
}

/**
 * Which of the three prose columns actually print for THIS set of matters.
 *
 * `MattersTable` prints a column once, as a note under the table, when every
 * row answers it identically — so a homogeneous set of twenty journals shows
 * one prose column and a mixed set of five shows three, and the same five
 * matters cost very different amounts of paper in the two cases. Duplicated
 * from the renderer deliberately: the renderer decides what to draw and this
 * decides what fits, and a shared helper across the service/component
 * boundary would put a layout decision in the service layer. The two are
 * pinned together on the printed sheet, by the overflow fixtures in
 * `tests/unit/print/packSheetCount.test.ts`: a drift between them shows up as
 * a thirteenth sheet, which is the only symptom that actually matters.
 */
const PROSE_KEYS = ['owner', 'movement', 'decisionRequired'] as const;

function printedProseKeys(matters: PackMatter[]): ReadonlyArray<(typeof PROSE_KEYS)[number]> {
  if (matters.length < 2) return PROSE_KEYS;
  return PROSE_KEYS.filter((key) => !matters.every((m) => m[key] === matters[0]![key]));
}

/** The lines this exact set of matters takes as a table, header included. */
export function mattersTableLines(matters: PackMatter[]): number {
  if (matters.length === 0) return 0;
  const prose = printedProseKeys(matters);
  const shares = ISSUE_SHARE + prose.length;
  const unit = (TABLE_CHARS - QUANTUM_CHARS) / shares;
  const issueChars = unit * ISSUE_SHARE;
  const rowLines = (m: PackMatter): number =>
    ROW_OVERHEAD_LINES + Math.max(
      wrappedLines(m.issue, issueChars),
      ...prose.map((key) => wrappedLines(m[key], unit)),
    );
  // The header row, plus a line for the rule under it.
  return 2 + matters.reduce((sum, m) => sum + rowLines(m), 0);
}

/**
 * The lines page 11 has for the table.
 *
 * The sheet's 255mm content box carries the page header, the matters
 * commentary, the "What was checked" disclosure, the omitted-matters note and
 * the repeated-column notes — about 70mm — leaving ~185mm. A table line is
 * 11pt of leading, 3.9mm. That is 47; this is 40, and the eight lines of
 * slack are what the estimate above is allowed to be wrong by. Proved on the
 * printed sheet by `tests/unit/print/packSheetCount.test.ts`, on the live
 * demo company's twenty-eight matters and on both of the reviewer's overflow
 * shapes.
 */
export const MATTERS_PRINTED_LINE_BUDGET = 30;

export interface SelectedMatters {
  /** The matters the page prints, in the order `buildMatters` ranked them. */
  printed: PackMatter[];
  /** The rest, so the page can state how many and what they come to. */
  omitted: PackMatter[];
}

export function selectPrintedMatters(
  matters: PackMatter[],
  budget: number = MATTERS_PRINTED_LINE_BUDGET,
): SelectedMatters {
  if (matters.length === 0) return { printed: [], omitted: [] };

  // Never dropped FIRST, but no longer never dropped: a matter with no rand
  // amount is a filing, a failed check or the "no matters" note, and the
  // quantum ranking buries all three — so they lead the ranking. What they no
  // longer do is bypass the budget, which is what made the cap not a cap.
  const ranked = [...matters].sort((a, b) => {
    if ((a.quantum === null) !== (b.quantum === null)) return a.quantum === null ? -1 : 1;
    return Math.abs(b.quantum ?? 0) - Math.abs(a.quantum ?? 0);
  });

  // Grown one matter at a time, re-measuring the WHOLE table each time: a
  // prose column collapses only when every printed row agrees, so adding the
  // eleventh matter can widen the tenth.
  let keep: PackMatter[] = [];
  for (const matter of ranked) {
    const next = [...keep, matter];
    if (mattersTableLines(next) > budget) break;
    keep = next;
  }
  // A single matter longer than the whole budget must still print — a page
  // that lists nothing and says "28 further matters are not printed" is the
  // silent-omission defect this file exists to prevent, wearing a note.
  if (keep.length === 0) keep = ranked.slice(0, 1);

  const printed = new Set(keep);
  return {
    printed: matters.filter((m) => printed.has(m)),
    omitted: matters.filter((m) => !printed.has(m)),
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
