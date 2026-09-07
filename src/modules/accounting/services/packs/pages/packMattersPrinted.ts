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
import { linesForChars } from './packTextMetrics';

/**
 * THE BUDGET IS THE PAPER THE PAGE HAS LEFT, NOT A ROW COUNT AND NOT A
 * FITTED CONSTANT.
 *
 * It was `MATTERS_PRINTED_MAX = 10`, and ten was measured — once, against one
 * company's twenty-eight matters. It is the wrong instrument twice over. It
 * was not a cap at all (every null-quantum matter was kept BEFORE the count
 * was consulted, so twenty filings printed twenty rows), and even honoured it
 * says nothing about how much paper ten rows take: a reviewer printed twenty
 * long null-quantum matters at FOURTEEN sheets and twenty-six short ones at
 * thirteen, through the harness, at HEAD. `getOverdueStatutoryFilings` has no
 * `LIMIT` and no `DISTINCT` on fiscal year, so a company with several draft
 * AFS documents across several years reaches both shapes on its own.
 *
 * It then became a LINE budget, fitted by sweeping a constant against the
 * print harness until a fixture spilled — better, and still a number measured
 * against the fixtures that existed on the day. The fixtures did not model
 * the live company's note lengths, so the scorecard's own footnote overflowed
 * next, on a page this file never looked at.
 *
 * So the budget is no longer a constant of this file at all. `packPageMetrics`
 * measures every block the pack can print, in millimetres; `fitPageToBox`
 * hands this function what page 11 has left after its heading, its commentary
 * and its disclosure have been paid for. A row's cost is its longest cell,
 * wrapped — including which prose columns collapse, which depends on the rows
 * chosen and therefore has to be re-measured as the set grows — and the
 * selection stops when the table would outgrow that space.
 */

/**
 * The table's own text width, in characters of the printed face.
 *
 * `.pack-matters` runs the full content box: A4 less the 18mm side margins is
 * 174mm, and the table's 8pt sans averages about 1.85mm per character across
 * this prose, so ~94 characters span the table. Cell padding and the column
 * rules take the rest.
 */
const TABLE_CHARS = 72;
/** The quantum column is numeric and narrow — "Quantum (R'000)" is its widest
 *  cell. Taken off the top before the prose columns share what is left. */
const QUANTUM_CHARS = 15;
/** The issue column carries the matter itself and is set wider than the prose
 *  columns beside it; this is its share when the shares are divided. */
const ISSUE_SHARE = 2;

/** `.pack-table th` on this table wraps — "Quantum (R'000)" takes two lines —
 *  so the header is budgeted at two. */
const MATTERS_HEAD_MM = 12;
/** One line of a `.pack-matters` row: 13pt of leading. */
const MATTERS_LINE_MM = 13 * (25.4 / 72);
/** What a row costs beyond its text: 1.2mm of cell padding top and bottom,
 *  and the 0.5pt rule under it. */
const MATTERS_ROW_PADDING_MM = 2.9;

/** Lines a string of `text` takes in a column `chars` wide. At least one: an
 *  empty cell is still a row. Word by word — see `packPageMetrics`'s own
 *  `wrappedLines` for why a division under-counts. */
function wrappedLines(text: string, chars: number): number {
  return linesForChars(text, chars);
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

/**
 * The cells a row's height depends on — its prose, and nothing else.
 *
 * Structural rather than `PackMatter`, because page 11 measures the block it
 * is about to print and by then every matter's quantum has been through the
 * provenance map and is a `PackFigureMatter`. The quantum column is numeric
 * and `nowrap`; it cannot make a row taller, so neither shape needs it.
 */
export type MeasurableMatter = Pick<PackMatter, 'issue' | typeof PROSE_KEYS[number]>;

function printedProseKeys(matters: MeasurableMatter[]): ReadonlyArray<(typeof PROSE_KEYS)[number]> {
  if (matters.length < 2) return PROSE_KEYS;
  return PROSE_KEYS.filter((key) => !matters.every((m) => m[key] === matters[0]![key]));
}

/** The millimetres this exact set of matters takes as a table, header
 *  included. Zero for an empty set — `MattersTable` draws no table at all. */
export function mattersTableMm(matters: MeasurableMatter[]): number {
  if (matters.length === 0) return 0;
  const prose = printedProseKeys(matters);
  const shares = ISSUE_SHARE + prose.length;
  const unit = (TABLE_CHARS - QUANTUM_CHARS) / shares;
  const issueChars = unit * ISSUE_SHARE;
  const rowMm = (m: MeasurableMatter): number =>
    MATTERS_ROW_PADDING_MM + MATTERS_LINE_MM * Math.max(
      wrappedLines(m.issue, issueChars),
      ...prose.map((key) => wrappedLines(m[key], unit)),
    );
  return MATTERS_HEAD_MM + matters.reduce((sum, m) => sum + rowMm(m), 0);
}

/**
 * ONE selection, read by BOTH pages that talk about the matters.
 *
 * Page 4's action panel and page 11's table are two views of one list, and
 * they were derived independently: page 4 counted `matters.length - shown`
 * and told the board "23 further matters follow on the matters page", while
 * page 11 printed six and disclosed twenty-two that follow nowhere. Each
 * count was right about its own page; the CROSS-REFERENCE between them was
 * false, in the governance section of a document a director forwards to
 * their bank. Two derivations of one quantity diverge the moment either
 * page's rules change, and the page that changed is not the page that lies.
 *
 * So the selection is computed once, in `buildBoardPackPages`, and handed to
 * both. Page 4 draws its bullets from `printed` — so every matter it names
 * is on the matters page — and states the remainder from the same two
 * arrays page 11 tabulates. `assertMattersCrossReference` holds them
 * together at compose time.
 */
export interface SelectedMatters {
  /** The matters page 11 prints, in the order it prints them: matters with
   *  no rand amount first, then by exposure, largest first. */
  printed: PackMatter[];
  /** The rest, in the same ranking, so the page can state how many and what
   *  they come to. */
  omitted: PackMatter[];
  /** The full list as `buildMatters` returned it — the order the provenance
   *  map ranks a quantum's source by, which must not move when the printing
   *  order does. */
  source: PackMatter[];
}

export function selectPrintedMatters(
  matters: PackMatter[],
  /** Millimetres of paper page 11 has left for the table — see
   *  `mattersBudgetMm`. Required: a default here is a fitted constant
   *  wearing an argument's clothes, which is what this file already had. */
  budgetMm: number,
): SelectedMatters {
  if (matters.length === 0) return { printed: [], omitted: [], source: matters };

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
    if (mattersTableMm(next) > budgetMm) break;
    keep = next;
  }
  // A single matter longer than the whole budget must still print — a page
  // that lists nothing and says "28 further matters are not printed" is the
  // silent-omission defect this file exists to prevent, wearing a note.
  if (keep.length === 0) keep = ranked.slice(0, 1);

  // IN THE RANKED ORDER, not the source order. The page states its own rule
  // — matters with no rand amount first, then the largest by exposure — and
  // it was selecting by that rule and then printing by `buildMatters`'s,
  // which put two AFS filings 739 and 10 days overdue FIFTH and SIXTH,
  // below four identical payroll journals. A note stating an order the rows
  // beneath it break is worse than no note: it tells a director the top of
  // the table is the top of the risk.
  const printed = new Set(keep);
  return {
    printed: keep,
    omitted: ranked.filter((m) => !printed.has(m)),
    source: matters,
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
