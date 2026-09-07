/**
 * THE PACK PRINTS THE SAME MEASURE OVER TWO DIFFERENT WINDOWS, AND BOTH ARE
 * RIGHT. This is where it says so — once on the trends page, and once on each
 * page that carries the period figure of a panel actually drawn.
 *
 * A page-10 panel plots one MONTH at a time and states its movement from the
 * first month of the series to the last. A statement page states the figure
 * for the WHOLE reporting period, measured against the comparative period.
 * The two answer different questions, so they do not agree, and on the live
 * demo pack they disagreed loudly:
 *
 *   - gross margin `(1348.0%)` for the period against `100.0%` for the last
 *     month;
 *   - debtor days `213` on the highlights and scorecard pages against `63.7`
 *     on the trends page;
 *   - "Revenue is up 1281.4% across 12 periods" against "Revenue has no
 *     positive comparative base for a percentage change".
 *
 * The first round of this fix wrote ONE note, about gross margin, pushed onto
 * the trends page unconditionally — which then printed on a pack that draws
 * no gross-margin panel at all (every month's revenue was nil), so the sheet
 * named a chart two centimetres above a disclosure explaining why that chart
 * is missing. Both halves of that are fixed here: the note is DERIVED from
 * the panels the page actually draws, so it can never name one that is not
 * there, and it covers every measure rather than the one that was noticed.
 *
 * PAGES ARE NAMED IN WORDS, never by number — page numbers come from position
 * in the sequence now, and a literal here is the class of cross-reference
 * that once sent a reader to the scorecard for the basis of preparation.
 */
import type { PackChartSpec, PackDisclosureNote, PackFootnote } from './packPageModel';

/**
 * A drawn panel, and where in the pack the same measure prints for the whole
 * period.
 *
 * Keyed by the panel id `packTrendCharts` issues, so a panel that stops being
 * drawn stops being named — that is the whole mechanism. A panel with no
 * entry here contributes nothing, which is the safe direction: a note that
 * names too few measures is thin, a note that names one the pack does not
 * print is false.
 */
interface PeriodCounterpart {
  /** How the measure is named on both pages. */
  measure: string;
  /** Which page carries the period figure, in the words the contents entry
   *  for that page uses. */
  page: string;
}

export const PERIOD_COUNTERPARTS: Record<string, PeriodCounterpart> = {
  'trend-revenue': { measure: 'revenue', page: 'income statement page' },
  'trend-gross-margin': { measure: 'gross margin', page: 'income statement page' },
  'trend-operating-expenses': { measure: 'operating expenses', page: 'income statement page' },
  'trend-net-profit': { measure: 'net profit', page: 'group results page' },
  'trend-cash': { measure: 'cash', page: 'cash page' },
  'trend-debtor-days': { measure: 'debtor days', page: 'scorecard page' },
};

/** "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The drawn panels that have a period counterpart, grouped by the page that
 *  carries it, in the order the panels are drawn. */
function counterpartsByPage(panels: PackChartSpec[]): Array<{ page: string; measures: string[] }> {
  const byPage: Array<{ page: string; measures: string[] }> = [];
  for (const panel of panels) {
    const counterpart = PERIOD_COUNTERPARTS[panel.id];
    if (counterpart === undefined) continue;
    const group = byPage.find((g) => g.page === counterpart.page);
    if (group) group.measures.push(counterpart.measure);
    else byPage.push({ page: counterpart.page, measures: [counterpart.measure] });
  }
  return byPage;
}

/**
 * The trends page's own note: which of the measures on this page ALSO print
 * as a period figure, where, and why the two will not agree.
 *
 * Null when no drawn panel has a counterpart — a page with nothing to
 * reconcile must not carry a paragraph reconciling it.
 */
export function trendWindowNote(panels: PackChartSpec[]): PackDisclosureNote | null {
  const groups = counterpartsByPage(panels);
  if (groups.length === 0) return null;

  const where = groups.map((g) => `${inWords(g.measures)} on the ${g.page}`);
  return {
    heading: 'Period',
    body:
      'Each panel plots one MONTH at a time. The same measures print for the WHOLE reporting '
      + `period — ${inWords(where)} — against the comparative period. Different windows: the two `
      + 'will not agree.',
  };
}

/**
 * The reciprocal pointer, for a page that carries the period figure — as a
 * page FOOTNOTE rather than a disclosure block.
 *
 * A director who reads the trends page first and turns back gets nothing from
 * a note that lives only on the trends page, which is what the rendered pack
 * did. But the two pages that need it are the two fullest in the pack: as a
 * headed disclosure it put the income statement 4.8mm and the scorecard
 * 12.2mm past the paper on the dense fixture, and a thirteenth sheet is not
 * an acceptable price for a cross-reference. The statement pages already
 * carry unreferenced footnotes of exactly this kind ("The prior column is the
 * period …"), so this is the shape the pack already uses for a fact about how
 * to read the page.
 *
 * Empty where the panel is not DRAWN, for the same reason as `trendWindowNote`
 * — a page must not point at a chart the pack does not contain.
 *
 * IT NAMES THE PAGE IT IS ABOUT. The note used to open "Debtor days on this
 * page is the figure for the whole reporting period" — and a render put it
 * alone on a blank thirteenth sheet, where "this page" pointed at nothing.
 * The composer now holds every page to its box so that cannot recur, but a
 * sentence whose truth depends on where it lands is the defect class this
 * whole page has been chasing: a reader who meets it out of context, in a
 * forwarded extract or a screen reader's linear order, can still tell which
 * page it means.
 *
 * @param pageName The page's own `navLabel` — the string the Contents prints,
 *   not a second spelling of it.
 * @param number The footnote number to issue, since the PAGE owns its own
 *   footnote numbering (see `PackKpiTile.trendFootnote`).
 */
export function periodWindowFootnotes(
  panels: PackChartSpec[],
  panelId: string,
  pageName: string,
  number: number,
): PackFootnote[] {
  const counterpart = PERIOD_COUNTERPARTS[panelId];
  if (counterpart === undefined) return [];
  if (!panels.some((panel) => panel.id === panelId)) return [];

  const measure = `${counterpart.measure.charAt(0).toUpperCase()}${counterpart.measure.slice(1)}`;
  return [{
    number,
    text:
      `${measure} on this page — the ${pageName.toLowerCase()} page — is the figure for the WHOLE `
      + 'reporting period, measured on the period totals; the trends page plots the same measure '
      + 'one month at a time. Different windows: the two will not agree.',
  }];
}
