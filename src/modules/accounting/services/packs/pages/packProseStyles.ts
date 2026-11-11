/**
 * THE PACK'S PROSE STYLES, AS THE PRINT STYLESHEET SETS THEM: the size and the weight of each kind of prose the page
 * model wraps (`packProseLines.proseLines`), with the CSS rule each is read from. `packProseStyles.test.ts` reads those
 * rules out of `styles/` and fails where one changes and this table does not, so the model cannot drift from the print.
 * A weight of 400 is the faces' regular, which a rule that declares no weight inherits from `.pack-page`.
 */
export type ProseWeight = 400 | 500 | 600;

export interface ProseStyle {
  /** The type size, in points. */
  readonly pt: number;
  /** The weight the text is set in. */
  readonly weight: ProseWeight;
  /** The stylesheet rule the size is read from, and the one the weight is (where another declares it). */
  readonly sizeRule: string;
  readonly weightRule: string;
}

const style = (pt: number, weight: ProseWeight, sizeRule: string, weightRule: string = sizeRule): ProseStyle => ({ pt, weight, sizeRule, weightRule });

export const PROSE = {
  /** A page's title (portrait), and on a landscape sheet. */
  title: style(15, 600, '.pack-title'),
  titleLandscape: style(13, 600, '.pack-page[data-print-landscape] .pack-title', '.pack-title'),
  /** A chart's title, and a small-multiples panel's. */
  chartTitle: style(10, 500, '.pack-chart-title'),
  panelTitle: style(8.5, 500, '.pack-small-multiples .pack-chart-title', '.pack-chart-title'),
  /** Page 4: the commentary, the actions list and the line under it. */
  narrativeBody: style(10, 400, '.pack-narrative-body'),
  actionItem: style(9.5, 400, '.pack-narrative-actions'),
  actionsTail: style(7.5, 400, '.pack-narrative-actions-tail'),
  /** A disclosure's heading, its notes (one column and two), and the heading each note opens with. */
  disclosureHeading: style(11, 600, '.pack-disclosure-heading'),
  disclosureBody: style(9.5, 400, '.pack-disclosure-body'),
  disclosureBodyTwoColumn: style(8.5, 400, '.pack-disclosure.is-two-column .pack-disclosure-body', '.pack-disclosure-body'),
  disclosureNoteHeading: style(9.5, 600, '.pack-disclosure-body', '.pack-disclosure-note-heading'),
  disclosureNoteHeadingTwoColumn: style(8.5, 600, '.pack-disclosure.is-two-column .pack-disclosure-body', '.pack-disclosure-note-heading'),
  /** The page's footnotes, a table's notes (a not-meaningful reason, a matters column the same for every row) and
   *  their labels, and the glossary's bridge note. */
  footnote: style(7.5, 400, '.pack-footnotes'),
  tableNote: style(7.5, 400, '.pack-table-notes'),
  tableNoteLabel: style(7.5, 600, '.pack-table-notes', '.pack-table-notes dt'),
  bridgeNote: style(7.5, 400, '.pack-definition-bridge-note'),
  /** The glossary's terms and definitions. */
  definition: style(8.5, 400, '.pack-definitions'),
  definitionTerm: style(8.5, 600, '.pack-definitions', '.pack-definition-term'),
  /** A scorecard group's heading, and a table's row label. */
  scorecardHeading: style(11, 600, '.pack-scorecard-heading'),
  tableLabel: style(9, 400, '.pack-table'),
  /** A matters cell, and the contents page's entries. */
  mattersCell: style(9, 400, '.pack-table'),
  contents: style(10, 400, '.pack-contents-list'),
} as const satisfies Record<string, ProseStyle>;
