/**
 * The row contract every statement surface renders through.
 *
 * Comparators are NAMED. A single anonymous `variance` was enough while prior
 * period was the only comparator, but the programme's target is
 * actual / prior / budget / forecast, and a second comparator would have
 * forced either a parallel `budgetVariance` triple or a rename reaching both
 * adapters, the row view and all five surfaces. `Comparison` is that shape,
 * declared once and reused per comparator.
 */
export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'grand' | 'empty';

/**
 * One comparator's figures for a row: its value, and the movement from it.
 * `favourable` is a POLARITY judgement made by the adapter — revenue up is
 * favourable, an expense or a liability up is not — never by the renderer.
 */
export interface Comparison {
  value: number;
  variance?: number;
  variancePct?: number;
  favourable?: boolean;
}

/** WS3: annotation presence on a row. Presentation only — it carries no figure
 *  and is never summed. Populated client-side by attachNotes, never by an
 *  adapter, so the adapters stay pure functions of the service report. */
export interface StatementRowNote {
  count: number;
  hasOpen: boolean;
}

export interface StatementRow {
  id: string;
  kind: StatementRowKind;
  label: string;
  depth: 0 | 1;
  accountCode?: string;
  actual: number;
  prior?: Comparison;
  /** Populated by WS1 (budget column). No adapter sets it yet. */
  budget?: Comparison;
  /** Populated by WS1 (12-month trend column). No adapter sets it yet. */
  trend?: number[];
  /** Account-detail destination. Set, the label renders as a link and the
   * expand chevron becomes a sibling button rather than wrapping it. */
  href?: string;
  /** WS3: set by attachNotes when this row has internal annotations. Never set
   *  on a share link — the share loader does not read annotations. */
  note?: StatementRowNote;
}

/** The comparator columns, in render order. One entry per named comparator on
 * StatementRow — adding forecast later is one line here and one field above. */
export const COMPARATORS = [
  { key: 'prior', label: 'Prior' },
  { key: 'budget', label: 'Budget' },
] as const;

export type ComparatorKey = (typeof COMPARATORS)[number]['key'];

export interface StatementColumns {
  prior: boolean;
  budget: boolean;
  variance: boolean;
  trend: boolean;
}

/**
 * What a surface with no comparator controls prints: the prior-period
 * checkbox alone decides, which is what every caller did before the trend and
 * budget columns existed. Both statement bodies fall back to this when
 * `columns` is omitted, and they must fall back to the SAME thing — two
 * copies of the literal is two default statements, and the first edit to one
 * of them makes the two surfaces disagree about what "no columns chosen"
 * means.
 */
export function comparativeOnlyColumns(showComparative: boolean): StatementColumns {
  return { prior: showComparative, budget: false, variance: showComparative, trend: false };
}

/**
 * `section` is a BAND HEADER and carries the band total in `actual`, which the
 * HTML view blanks because the band's own `subtotal` row prints it. A non-HTML
 * consumer summing rows must skip `section` rows or it counts every band
 * twice: the subtotal is the figure.
 *
 * `empty` is the "No asset balances" placeholder — a label and nothing else.
 * Its `actual` is 0 and is never a figure; it is not part of any total.
 */
export const NON_FIGURE_KINDS: ReadonlySet<StatementRowKind> = new Set(['section', 'empty']);
