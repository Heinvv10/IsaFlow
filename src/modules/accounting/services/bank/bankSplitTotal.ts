/**
 * The one split-total rule (WP2 row 11), shared by `splitAllocateTransaction` and the MCP split tool so the two can
 * never disagree: the lines equal the bank line in INTEGER CENTS, exactly — never a float tolerance, which let R5.01
 * of lines through for an R5.00 line (5.01 - 5.00 is 0.00999… in IEEE-754). Callers check whole cents per line first.
 */
import { toCents } from '../ap/billAllocatable';
import { formatMoney } from '@/lib/money/formatMoney';

/** The refusal text naming both totals in rands, or null when the lines equal the line. Sign of `lineAmount` ignored. */
export function splitTotalMismatch(amounts: readonly number[], lineAmount: number): string | null {
  const linesCents = amounts.reduce((sum, a) => sum + toCents(Number(a)), 0);
  const lineCents = Math.abs(toCents(Number(lineAmount)));
  if (linesCents === lineCents) return null;
  return `Split lines total ${formatMoney(linesCents / 100)} does not equal the transaction amount `
    + `${formatMoney(lineCents / 100)}. Nothing was posted.`;
}
