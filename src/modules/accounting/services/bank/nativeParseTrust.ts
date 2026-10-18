/**
 * Whether the rows a bank's own PDF parser returned may stand in for a page-by-page read.
 *
 * The parsers skip a line they cannot read and carry on, so a result with rows is not a
 * complete result. What betrays a dropped line:
 *   - the parser's own row errors;
 *   - a row without a running balance, or balances that do not follow from the amounts (a row missing
 *     between two balances). Every row must carry one: a result with none, or some, proves nothing;
 *   - where the parser read the printed "balance brought forward", a first row that does not follow from
 *     it (a dropped first row);
 *   - where the parser derives each amount from the balances (ABSA), so that its balances chain by
 *     construction, an amount that differs from the one printed on the line.
 * A dropped LAST row is not caught: no parser reads a printed closing balance, because the layouts do not
 * label one consistently (ABSA repeats a page balance in its header; Standard Bank's text has none).
 *
 * Measured on real statements: ABSA and Standard Bank read with no errors and every balance chaining; two FNB
 * statements gave errors on a tenth to a quarter of their lines and balances that chained once in a hundred
 * pairs. A result that fails any test goes to the page reader.
 */

import type { BankCsvParseResult, ParsedBankTransaction } from '@/modules/accounting/types/bank.types';

/** Rounding slack between an amount and the balances around it, in cents. */
const TOLERANCE_CENTS = 2;

const cents = (n: number) => Math.round(n * 100);
const within = (a: number, b: number) => Math.abs(cents(a) - cents(b)) <= TOLERANCE_CENTS;

/**
 * Every balance follows from the previous one and the amounts, and (when known) the oldest row follows from
 * the opening balance. Rows may be oldest first or newest first; either order will do.
 */
function balancesChain(rows: ParsedBankTransaction[], opening: number | undefined): boolean {
  // With nothing before the first row to compare against, a single row proves nothing.
  if (rows.length < 2 && opening === undefined) return false;
  const holds = (newestFirst: boolean) => {
    for (let k = 1; k < rows.length; k++) {
      const [older, newer] = newestFirst ? [rows[k]!, rows[k - 1]!] : [rows[k - 1]!, rows[k]!];
      if (!within(older.balance! + newer.amount, newer.balance!)) return false;
    }
    if (opening === undefined) return true;
    const oldest = newestFirst ? rows[rows.length - 1]! : rows[0]!;
    return within(opening + oldest.amount, oldest.balance!);
  };
  return holds(false) || holds(true);
}

/** True when `parsed` (rows from the parser written for the statement's bank) shows no sign of a dropped line. */
export function nativeRowsAreComplete(parsed: BankCsvParseResult): boolean {
  const rows = parsed.transactions;
  if (parsed.errors.length > 0 || rows.length === 0) return false;
  if (rows.some((r) => r.balance === undefined || r.balance === null)) return false;
  if (rows.some((r) => r.printedAmount !== undefined && !within(Math.abs(r.amount), r.printedAmount))) return false;
  return balancesChain(rows, parsed.openingBalance);
}
