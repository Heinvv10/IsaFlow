/**
 * A statement's opening and closing balance, and what an import batch may store of it (WP1 PR-A, migration 998).
 * Pure: no DB, no clock.
 *
 * deriveStatementBalances reads the WHOLE parsed file — parseStatement calls it on the raw parse, before the
 * ledger-window filter and before any dedupe — so a re-import whose first lines already exist still records the
 * file's own figures. All arithmetic is in integer cents: a float chain test fails on 0.1 + 0.2.
 *
 * Rules, in order:
 *  1. The file states a closing balance (OFX BALAMT, MT940 :62F:): 'printed'; opening is the stated one (:60F:)
 *     or null.
 *  2. No line carries a finite running balance: 'not_in_file'.
 *  3. Some lines carry one and others do not: 'unverified'.
 *  4. Every line carries one: the ascending chain (bal[i] − bal[i−1] = amt[i]) gives opening bal[0] − amt[0] and
 *     closing bal[n−1]; else the descending chain (bal[i−1] − bal[i] = amt[i−1]) gives opening bal[n−1] − amt[n−1]
 *     and closing bal[0]; neither: 'unverified'. One line satisfies both and reads ascending.
 *  5. A PDF's printed "brought forward" (raw.openingBalance) that differs from the derived opening: 'unverified'.
 * `asAt` is the latest YYYY-MM-DD line date in the file.
 *
 * batchBalanceColumns is the write rule: figures only for 'printed' / 'running_balance' whose asAt is on or before
 * the statement date; a later line makes them NULL and 'unverified'; no balances at all write NULL throughout.
 */
import type { BalanceSource, BankCsvParseResult, StatementBalances } from '../../types/bank.types';

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

/** Integer cents of a finite amount, rounded half away from zero; null for anything else. */
function toCents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.sign(v) * Math.round(Math.abs(v) * 100);
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

export function deriveStatementBalances(raw: BankCsvParseResult): StatementBalances {
  const asAt = latestDay(raw);
  const statedClosing = toCents(raw.closingBalance);
  const statedOpening = toCents(raw.openingBalance);
  if (statedClosing !== null) return { source: 'printed', openingCents: statedOpening, closingCents: statedClosing, asAt };

  const bal = raw.transactions.map((t) => toCents(t.balance));
  const amt = raw.transactions.map((t) => toCents(t.amount));
  const withBalance = bal.filter((b) => b !== null).length;
  if (withBalance === 0) return none('not_in_file', asAt);
  if (withBalance < bal.length || amt.some((a) => a === null)) return none('unverified', asAt);

  const b = bal as number[];
  const a = amt as number[];
  const n = b.length;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < n; i++) {
    if (b[i]! - b[i - 1]! !== a[i]) ascending = false;
    if (b[i - 1]! - b[i]! !== a[i - 1]) descending = false;
  }
  let openingCents: number;
  let closingCents: number;
  if (ascending) {
    openingCents = b[0]! - a[0]!;
    closingCents = b[n - 1]!;
  } else if (descending) {
    openingCents = b[n - 1]! - a[n - 1]!;
    closingCents = b[0]!;
  } else {
    return none('unverified', asAt);
  }
  if (statedOpening !== null && statedOpening !== openingCents) return none('unverified', asAt);
  return { source: 'running_balance', openingCents, closingCents, asAt };
}

export interface BatchBalanceColumns {
  /** NUMERIC text with two decimals, exact (built from integer cents), or null. */
  openingBalance: string | null;
  closingBalance: string | null;
  balanceSource: BalanceSource | null;
}

function centsText(cents: number | null): string | null {
  if (cents === null) return null;
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** What `bank_import_batches` stores for a batch written with `statementDate` (the write rule above). */
export function batchBalanceColumns(sb: StatementBalances | undefined, statementDate: string): BatchBalanceColumns {
  if (!sb) return { openingBalance: null, closingBalance: null, balanceSource: null };
  if (sb.source !== 'printed' && sb.source !== 'running_balance') {
    return { openingBalance: null, closingBalance: null, balanceSource: sb.source };
  }
  const statementDay = ISO_DAY.exec(statementDate)?.[1] ?? null;
  // A line dated after the statement date (or a date that cannot be compared) means the figures are not the
  // balance AS AT that date: none is stored.
  if (sb.asAt === null || statementDay === null || sb.asAt > statementDay) {
    return { openingBalance: null, closingBalance: null, balanceSource: 'unverified' };
  }
  return { openingBalance: centsText(sb.openingCents), closingBalance: centsText(sb.closingCents), balanceSource: sb.source };
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
