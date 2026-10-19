/**
 * VLM statement merge — joins the per-page reads of one statement.
 *
 * Rows keep page order. Header fields come from the first page that printed
 * them; the opening balance from the front of the statement and the closing
 * balance from the back (a later page's "brought forward" figure is not the
 * statement's opening balance); the period spans the earliest start to the
 * latest end.
 */

import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';
import type { SupplierStatementExtraction } from './vlmSupplierStatementService';

const NO_TRANSACTIONS = 'No transactions extracted from bank statement';
const NO_LINES = 'No lines extracted from supplier statement';
/** A cent of rounding between the printed balances and the sum of the rows. */
const CONTINUITY_TOLERANCE_CENTS = 1;

/** First non-null value, in page order. */
function first<T>(values: Array<T | null | undefined>): T | null {
  for (const v of values) if (v !== null && v !== undefined) return v;
  return null;
}

/** Last non-null value, in page order. */
function last<T>(values: Array<T | null | undefined>): T | null {
  return first([...values].reverse());
}

/** ISO dates sort as strings. */
function earliest(dates: Array<string | null | undefined>): string | null {
  const present = dates.filter((d): d is string => !!d);
  return present.length > 0 ? present.reduce((a, b) => (a < b ? a : b)) : null;
}

function latest(dates: Array<string | null | undefined>): string | null {
  const present = dates.filter((d): d is string => !!d);
  return present.length > 0 ? present.reduce((a, b) => (a > b ? a : b)) : null;
}

function pooled(pageWarnings: string[][]): string[] {
  return [...new Set(pageWarnings.flat())];
}

const cents = (n: number) => Math.round(n * 100);
const money = (cents100: number) => (cents100 / 100).toFixed(2);

/** A warning when the opening balance plus the rows does not reach the closing balance. */
function continuityWarning(
  opening: number | null, closing: number | null, amounts: number[],
): string | null {
  if (opening === null || closing === null) return null;
  const sum = amounts.reduce((s, a) => s + cents(a), 0);
  const expected = cents(opening) + sum;
  if (Math.abs(expected - cents(closing)) <= CONTINUITY_TOLERANCE_CENTS) return null;
  return `Balance check: the opening balance ${money(cents(opening))} plus the ${amounts.length} transactions read `
    + `(${money(sum)}) is ${money(expected)}, but the closing balance is ${money(cents(closing))} `
    + '— a transaction may be missing or misread.';
}

export function mergeBankPages(pages: ExtractedBankStatement[]): ExtractedBankStatement {
  const transactions = pages.flatMap((p) => p.transactions);
  const from = earliest(pages.map((p) => p.statementPeriod?.from));
  const to = latest(pages.map((p) => p.statementPeriod?.to));
  const openingBalance = first(pages.map((p) => p.openingBalance));
  const closingBalance = last(pages.map((p) => p.closingBalance));

  const warnings = pooled(pages.map((p) => p.warnings));
  if (transactions.length === 0) warnings.push(NO_TRANSACTIONS);
  const continuity = continuityWarning(openingBalance, closingBalance, transactions.map((t) => t.amount));
  if (continuity) warnings.push(continuity);

  return {
    bankName: first(pages.map((p) => p.bankName)),
    accountNumber: first(pages.map((p) => p.accountNumber)),
    statementPeriod: from || to ? { from, to } : null,
    openingBalance,
    closingBalance,
    transactions,
    confidence: transactions.length > 0 ? 0.85 : 0.1,
    warnings,
  };
}

export function mergeSupplierPages(pages: SupplierStatementExtraction[]): SupplierStatementExtraction {
  const lines = pages.flatMap((p) => p.lines);
  const warnings = pooled(pages.map((p) => p.warnings));
  if (lines.length === 0) warnings.push(NO_LINES);
  return {
    supplierName: first(pages.map((p) => p.supplierName)) ?? undefined,
    statementDate: first(pages.map((p) => p.statementDate)) ?? undefined,
    periodStart: earliest(pages.map((p) => p.periodStart)) ?? undefined,
    periodEnd: latest(pages.map((p) => p.periodEnd)) ?? undefined,
    openingBalance: first(pages.map((p) => p.openingBalance)) ?? undefined,
    closingBalance: last(pages.map((p) => p.closingBalance)) ?? undefined,
    lines,
    warnings,
  };
}
