/**
 * Review round 3 (WP1 PR-A): a PDF text parser passes over a line it cannot read and carries on, so a dropped LAST
 * row leaves the survivors still chaining and a wrong closing would be stored as running_balance. A parser that skips
 * a line which looks like one of its own transaction rows (its row's date shape, plus an amount) records that here,
 * and the statement's balances are then 'unverified' (deriveStatementBalances reads balancesUnverifiable).
 *
 * Which parsers can skip a row silently, and so call this: the three ABSA layouts (slash-date, text-date, investment)
 * and Standard Bank's column layout. FNB, Nedbank, Capitec and Standard Bank's dated-row layout turn every dated
 * line into a row or a row error already, which deriveStatementBalances also treats as doubt.
 */
import type { BankCsvParseResult } from '../types/bank.types';

/** An amount as the statement layouts print one: two decimals after a point or a comma. */
const PDF_AMOUNT = /\d[.,]\d{2}(?!\d)/;

/** The same figure to the cent. */
export function sameCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Record that `line` (number `lineNum`) looks like a transaction row the parser did not read, if it carries an amount. */
export function noteUnreadRow(result: BankCsvParseResult, lineNum: number, line: string): void {
  if (!PDF_AMOUNT.test(line)) return;
  result.balancesUnverifiable ??= `PDF line ${lineNum} looks like a transaction but was not read`;
}

/** An ABSA text-date line ("15 Jan 2026 …") that is not a brought/carried-forward balance line. */
export function looksLikeAbsaTextRow(line: string): boolean {
  return /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s/.test(line) && !/brought|carried|forward/i.test(line);
}

/** A Standard Bank column-layout line (page, description, fee, debit, credit, YYYYMMDD, balance) that rowPat missed. */
export function looksLikeSbColumnRow(line: string): boolean {
  return /^\d+\s/.test(line) && (line.match(/\d\.\d{2}(?!\d)/g) ?? []).length >= 3;
}
