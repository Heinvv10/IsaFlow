/**
 * The report pack's cash-flow and ratio rows — ONE reading, rendered by both
 * the HTML pack and the PDF pack, for the same reason `incomeStatementPackRows`
 * exists: the two renderers each read the section blob by key, and each got
 * the same thing wrong.
 *
 * WHAT THEY GOT WRONG. A section says which of its figures it cannot stand
 * behind — `cash_flow` in an `unavailable` map, `ratios` in `notMeaningful` —
 * and neither renderer looked. The cash flow table printed the stand-in
 * numbers the blob still carries (net profit as operating cash flow). The
 * ratios table dropped every null ratio without a word and printed the
 * reasons map itself as a row reading "[object Object]".
 *
 * A row here has a figure or a reason, never both and never neither.
 */
import { ratioLines, type RatioLine } from './ratioPresentation';

export type PackValueRow =
  | { label: string; value: number; reason?: undefined }
  | { label: string; value: null; reason: string };

const CASH_FLOW_ROWS: ReadonlyArray<[field: string, label: string]> = [
  ['operatingCashFlow', 'Operating Cash Flow'],
  ['investingCashFlow', 'Investing Cash Flow'],
  ['financingCashFlow', 'Financing Cash Flow'],
  ['netCashFlow', 'Net Cash Flow'],
  ['openingCash', 'Opening Cash'],
  ['closingCash', 'Closing Cash'],
];

function reasonsIn(value: unknown): Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? '0')));

/** The six cash-flow lines, in statement order. */
export function cashFlowPackRows(d: Record<string, unknown>): PackValueRow[] {
  const unavailable = reasonsIn(d.unavailable);
  return CASH_FLOW_ROWS.map(([field, label]): PackValueRow => {
    const reason = unavailable[field];
    return reason === undefined
      ? { label, value: num(d[field]) }
      : { label, value: null, reason };
  });
}

/**
 * Every ratio the section carries, in the order it carries them, each under
 * its name and in its unit — see `ratioPresentation.ts`. A ratio the engine
 * could not state keeps its row and prints the reason; anything in the blob
 * that is neither a number nor null (the reasons map) gets no row.
 */
export function ratioPackRows(d: Record<string, unknown>): RatioLine[] {
  return ratioLines(d);
}
