/**
 * Whether the rows a bank's own PDF parser returned may stand in for a page-by-page read.
 *
 * The parsers skip a line they cannot read and carry on, so a result with rows is not a
 * complete result. Two things betray a dropped line: the parser's own row errors, and a
 * running balance that does not follow from the amounts (a row missing between two balances).
 * Measured on real statements: ABSA and Standard Bank read with no errors and every balance
 * chaining; two FNB statements gave errors on a tenth to a quarter of their lines and balances
 * that chained once in a hundred pairs. A result that fails either test goes to the page reader.
 */

import type { BankCsvParseResult, ParsedBankTransaction } from '@/modules/accounting/types/bank.types';

/** Rounding slack between an amount and the balances around it, in cents. */
const TOLERANCE_CENTS = 2;

const cents = (n: number) => Math.round(n * 100);

/** Every balance equals the previous balance plus the amounts since (rows may be oldest first or newest first). */
function balancesChain(rows: ParsedBankTransaction[]): boolean {
  const at = rows.flatMap((r, i) => (r.balance === undefined || r.balance === null ? [] : [i]));
  const holds = (reverse: boolean) => at.every((q, k) => {
    if (k === 0) return true;
    const p = at[k - 1]!;
    // oldest first: balance[q] = balance[p] + amounts of rows p+1..q; newest first: balance[p] = balance[q] + amounts of rows p..q-1
    const between = rows.slice(reverse ? p : p + 1, reverse ? q : q + 1).reduce((s, r) => s + cents(r.amount), 0);
    const [from, to] = reverse ? [q, p] : [p, q];
    return Math.abs(cents(rows[from]!.balance!) + between - cents(rows[to]!.balance!)) <= TOLERANCE_CENTS;
  });
  return holds(false) || holds(true);
}

/** True when `parsed` (rows from the parser written for the statement's bank) shows no sign of a dropped line. */
export function nativeRowsAreComplete(parsed: BankCsvParseResult): boolean {
  return parsed.errors.length === 0 && balancesChain(parsed.transactions);
}
