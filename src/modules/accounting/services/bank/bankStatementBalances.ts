/**
 * A statement's opening and closing balance, and what an import batch may store of it (WP1 PR-A, migration 998).
 * Pure: no DB, no clock.
 *
 * deriveStatementBalances reads the WHOLE parsed file — parseStatement calls it on the raw parse, before the
 * ledger-window filter and before any dedupe — so a re-import whose first lines already exist still records the
 * file's own figures. All arithmetic is in integer cents: a float chain test fails on 0.1 + 0.2.
 *
 * The rule over all of it (review round 2): a wrong figure is never stored as printed, running_balance or ai_read.
 * Any doubt makes the statement 'unverified', with no figures.
 *
 * Rules, in order:
 *  0. No line carries a balance and the file states none: 'not_in_file' (whatever else is wrong with it).
 *  1. Doubt about the file itself is 'unverified': the parser skipped a line (raw.errors: a bad date or amount, so
 *     the surviving lines can still chain to a wrong opening or closing), the parser flagged its balances
 *     (raw.balancesUnverifiable: an unreadable balance cell, two accounts or statements in one file, chained
 *     statements that do not join), or a PDF line's derived amount differs from the amount it printed.
 *  2. The file states a closing balance (OFX LEDGERBAL BALAMT, MT940 :62F:): 'printed'; opening is the stated one
 *     (:60F:) or null. A stated opening must add up: opening + Σ amounts = closing, else 'unverified'.
 *  3. Some lines carry a running balance and others do not: 'unverified'.
 *  4. Every line carries one: the ascending chain (bal[i] − bal[i−1] = amt[i]) gives opening bal[0] − amt[0] and
 *     closing bal[n−1]; the descending chain (bal[i−1] − bal[i] = amt[i−1]) gives opening bal[n−1] − amt[n−1] and
 *     closing bal[0]. Neither holds: 'unverified'. Both hold with different figures (alternating +x/−x): ambiguous,
 *     'unverified'. ONE line chains both ways and cannot show whether its balance is before or after the line, and
 *     no format here is proven to print it after: 'unverified'.
 *  5. A PDF's printed "brought forward" (raw.openingBalance) that differs from the derived opening: 'unverified'.
 *  6. A text-parsed PDF (opts.textPdf) whose chain holds is 'pdf_read', never 'running_balance' (round 4): no PDF
 *     parser reads a printed closing, so a dropped row (garbled, or split over two lines) leaves the survivors
 *     chaining to a closing nothing can check. 'pdf_read' says "taken from the PDF's running-balance column; not
 *     checked against a printed closing"; it is stored and compared like any figure, so an error shows as a
 *     Difference instead of passing as checked.
 * `asAt` is the latest YYYY-MM-DD line date in the file.
 *
 * batchBalanceColumns is the write rule: figures only for 'printed' / 'running_balance' / 'pdf_read' whose asAt is on or before
 * the statement date and that the column can hold; otherwise NULL and 'unverified'; no balances at all write NULL
 * throughout. ocrBalanceColumns is the same rule for an AI-read statement ('ai_read', never 'printed').
 */
import type { BalanceSource, BankCsvParseResult, StatementBalances } from '../../types/bank.types';

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * opening_balance / closing_balance are NUMERIC(15,2) where migration 253 created the table and NUMERIC(18,2) where
 * 442 did: |cents| must stay below 10^15 for the smaller, or the INSERT overflows and fails the whole import.
 */
export const MAX_BALANCE_CENTS = 1e15;

/** Integer cents of a finite amount, rounded half away from zero; null for anything else. */
function toCents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const cents = Math.sign(v) * Math.round(Math.abs(v) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function latestDay(raw: BankCsvParseResult): string | null {
  let latest: string | null = null;
  for (const t of raw.transactions) {
    const day = ISO_DAY.exec(String(t.transactionDate ?? ''))?.[1];
    if (day && (latest === null || day > latest)) latest = day;
  }
  return latest;
}

const none = (source: BalanceSource, asAt: string | null): StatementBalances =>
  ({ source, openingCents: null, closingCents: null, asAt });

/** Σ of the cents, or null when any is missing. */
function sumCents(cents: Array<number | null>): number | null {
  let sum = 0;
  for (const c of cents) {
    if (c === null) return null;
    sum += c;
  }
  return sum;
}

export function deriveStatementBalances(raw: BankCsvParseResult, opts: { textPdf?: boolean } = {}): StatementBalances {
  const asAt = latestDay(raw);
  const statedClosing = toCents(raw.closingBalance);
  const statedOpening = toCents(raw.openingBalance);
  const bal = raw.transactions.map((t) => toCents(t.balance));
  const amt = raw.transactions.map((t) => toCents(t.amount));
  const withBalance = bal.filter((b) => b !== null).length;
  const statesAny = raw.closingBalance !== undefined || raw.openingBalance !== undefined;
  if (withBalance === 0 && !statesAny && !raw.balancesUnverifiable) return none('not_in_file', asAt);

  if (raw.errors.length > 0 || raw.balancesUnverifiable) return none('unverified', asAt);
  if (raw.transactions.some((t) => t.printedAmount !== undefined
    && toCents(Math.abs(t.amount)) !== toCents(t.printedAmount))) return none('unverified', asAt);

  if (statedClosing !== null) {
    if (statedOpening !== null && statedOpening + (sumCents(amt) ?? Number.NaN) !== statedClosing) return none('unverified', asAt);
    return { source: 'printed', openingCents: statedOpening, closingCents: statedClosing, asAt };
  }
  if (withBalance < bal.length || amt.some((a) => a === null)) return none('unverified', asAt);

  const b = bal as number[];
  const a = amt as number[];
  const n = b.length;
  if (n < 2) return none('unverified', asAt);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < n; i++) {
    if (b[i]! - b[i - 1]! !== a[i]) ascending = false;
    if (b[i - 1]! - b[i]! !== a[i - 1]) descending = false;
  }
  const asc = { openingCents: b[0]! - a[0]!, closingCents: b[n - 1]! };
  const desc = { openingCents: b[n - 1]! - a[n - 1]!, closingCents: b[0]! };
  let figures: { openingCents: number; closingCents: number };
  if (ascending && descending) {
    if (asc.openingCents !== desc.openingCents || asc.closingCents !== desc.closingCents) return none('unverified', asAt);
    figures = asc;
  } else if (ascending) {
    figures = asc;
  } else if (descending) {
    figures = desc;
  } else {
    return none('unverified', asAt);
  }
  if (statedOpening !== null && statedOpening !== figures.openingCents) return none('unverified', asAt);
  return { source: opts.textPdf ? 'pdf_read' : 'running_balance', ...figures, asAt };
}

export interface BatchBalanceColumns {
  /** NUMERIC text with two decimals, exact (built from integer cents), or null. */
  openingBalance: string | null;
  closingBalance: string | null;
  balanceSource: BalanceSource | null;
}

const UNVERIFIED_COLUMNS: BatchBalanceColumns = { openingBalance: null, closingBalance: null, balanceSource: 'unverified' };

function centsText(cents: number | null): string | null {
  if (cents === null) return null;
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const fits = (cents: number | null) => cents === null || Math.abs(cents) < MAX_BALANCE_CENTS;

/** What `bank_import_batches` stores for a batch written with `statementDate` (the write rule above). */
export function batchBalanceColumns(sb: StatementBalances | undefined, statementDate: string): BatchBalanceColumns {
  if (!sb) return { openingBalance: null, closingBalance: null, balanceSource: null };
  if (sb.source !== 'printed' && sb.source !== 'running_balance' && sb.source !== 'pdf_read') {
    return { openingBalance: null, closingBalance: null, balanceSource: sb.source };
  }
  const statementDay = ISO_DAY.exec(statementDate)?.[1] ?? null;
  // A line dated after the statement date (or a date that cannot be compared) means the figures are not the
  // balance AS AT that date: none is stored. Nor is a figure the column cannot hold.
  if (sb.asAt === null || statementDay === null || sb.asAt > statementDay) return UNVERIFIED_COLUMNS;
  if (sb.closingCents === null || !fits(sb.closingCents) || !fits(sb.openingCents)) return UNVERIFIED_COLUMNS;
  return { openingBalance: centsText(sb.openingCents), closingBalance: centsText(sb.closingCents), balanceSource: sb.source };
}

export interface OcrStatementRead {
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  /** Every line the read found (duplicates included: they are lines of this statement too). */
  rows: Array<{ date: string | null | undefined; amount: number }>;
}

/**
 * The write rule for an AI-read statement (bank-statements commit). A closing balance is stored, as 'ai_read' and
 * with the opening when one was read, only when: the period is read and ordered (start ≤ end); every line has a
 * YYYY-MM-DD date inside it; a read opening adds up to the closing over the lines; and both fit the column. No
 * closing: 'not_in_file' (an opening alone is never stored). Anything else: 'unverified'.
 */
export function ocrBalanceColumns(read: OcrStatementRead): BatchBalanceColumns {
  const closing = toCents(read.closingBalance);
  if (closing === null) {
    return read.closingBalance === null
      ? { openingBalance: null, closingBalance: null, balanceSource: 'not_in_file' }
      : UNVERIFIED_COLUMNS;
  }
  const opening = read.openingBalance === null ? null : toCents(read.openingBalance);
  if (read.openingBalance !== null && opening === null) return UNVERIFIED_COLUMNS;
  const { periodStart: start, periodEnd: end } = read;
  if (!start || !end || !ISO_DATE.test(start) || !ISO_DATE.test(end) || start > end) return UNVERIFIED_COLUMNS;
  for (const r of read.rows) {
    const day = r.date ?? '';
    if (!ISO_DATE.test(day) || day < start || day > end) return UNVERIFIED_COLUMNS;
  }
  if (opening !== null && opening + (sumCents(read.rows.map((r) => toCents(r.amount))) ?? Number.NaN) !== closing) {
    return UNVERIFIED_COLUMNS;
  }
  if (!fits(closing) || !fits(opening)) return UNVERIFIED_COLUMNS;
  return { openingBalance: centsText(opening), closingBalance: centsText(closing), balanceSource: 'ai_read' };
}

const CHANNEL_LABELS: Record<string, string> = {
  statement_ocr: 'PDF (read by AI)',
  extension: 'Bank feed',
  classified: 'Worksheet',
};

const FORMAT_LABELS: Record<string, string> = {
  fnb: 'FNB', standard_bank: 'Standard Bank', nedbank: 'Nedbank', absa: 'ABSA', capitec: 'Capitec',
  generic: 'CSV', ofx: 'OFX', qif: 'QIF', mt940: 'MT940',
};

/** The statement format chip's text: the import channel when it says more than the format, else the format. */
export function statementSourceLabel(bankFormat: string | null, importChannel: string | null): string {
  const byChannel = importChannel ? CHANNEL_LABELS[importChannel] : undefined;
  if (byChannel) return byChannel;
  if (!bankFormat) return 'Unknown format';
  return FORMAT_LABELS[bankFormat] ?? bankFormat.toUpperCase();
}
