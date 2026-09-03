/**
 * Bank statement coverage — can this company's bank history account for itself?
 *
 * ── THE FINDING THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * 203 bank lines were missing from Velocity Fibre's primary account and were
 * found only by holding IsaFlow next to Sage. Nothing in the product could say
 * "this account has fourteen months of history with a four-month hole in the
 * middle", so the hole survived every screen anyone looked at. A coverage report
 * finds that WITHOUT a second system, because the evidence is already in the
 * data: the dates either run continuously or they do not.
 *
 * ── THE THREE BALANCES ARE REPORTED SEPARATELY, ON PURPOSE ──────────────────
 *
 *   glBalance        what the ledger says (cash.balance.v1, from the owning
 *                    service — this report does not re-derive it)
 *   statementBalance what the imported statement lines sum to
 *   computedBalance  the recorded opening balance plus the statement lines
 *
 * Reconciling those into one number is the thing that must not happen. On
 * Velocity the GL says R3,458,375.43 and the statements say R1,018,633.08; on
 * Brightsphere R4,692,520.19 against −R1,809,234.91. The GAP is the finding, and
 * a report that presents a single agreed figure has destroyed it. `difference`
 * is stated as a number so a reader can act on it, never netted away.
 *
 * ── WHAT IT DOES NOT COVER ──────────────────────────────────────────────────
 *
 * It cannot see a transaction that was never imported — that is the point, and
 * also the limit. A gap is evidence that lines are missing; the absence of a gap
 * is NOT evidence that they are all there, because a whole month absent from
 * both ends of the history leaves no gap to find. That is what `staleDays` and
 * the month table are for: a reader compares the months against the statements
 * they hold.
 */

import { log } from '@/lib/logger';
import { getCashBalance } from './cashBalanceService';
import {
  fetchCoverageAccounts,
  fetchCoverageGaps,
  fetchCoverageMonths,
  fetchDuplicateReferences,
  type CoverageGapRow,
  type CoverageMonthRow,
  type DuplicateReferenceRow,
} from './bankCoverageQueries';

export const DEFAULT_MIN_GAP_DAYS = 7;

export interface BankAccountCoverage {
  bankAccountId: string;
  accountCode: string;
  accountName: string;
  /** The picker flag. Reported; never used to exclude an account from here. */
  isActive: boolean;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  transactionCount: number;
  /** SUM of every imported line up to the reporting date. */
  netMovement: number;
  /** Days between the last transaction and the reporting date, or null. */
  staleDays: number | null;
  months: Array<Omit<CoverageMonthRow, 'bankAccountId'>>;
  gaps: Array<Omit<CoverageGapRow, 'bankAccountId'>>;
  duplicateReferences: Array<Omit<DuplicateReferenceRow, 'bankAccountId'>>;
  openingBalance: { amount: number | null; asAt: string | null };
  /** cash.balance.v1 for this account. */
  glBalance: number;
  /** Same as netMovement; named for what it means to a reader. */
  statementBalance: number;
  /** Opening balance + statement lines: what the bank should be showing. */
  computedBalance: number;
  /** glBalance − computedBalance. Stated, never netted away. */
  glVsComputedDifference: number;
}

export interface BankStatementCoverage {
  asAt: string;
  accounts: BankAccountCoverage[];
  totals: {
    glBalance: number;
    statementBalance: number;
    computedBalance: number;
    difference: number;
    transactionCount: number;
  };
  /**
   * The latest ledger write consumed, ISO-8601. Falls back to the newest bank
   * import when nothing is posted, because a report over an unposted import
   * still has a "through" and reporting null there would read as "no data".
   */
  postedThrough: string | null;
}

export interface CoverageOptions {
  /** YYYY-MM-DD. Everything is bounded at this date. */
  asAt: string;
  /** Narrow to one bank GL account. Caller has already checked ownership. */
  bankAccountId?: string;
  /** Shortest run of empty days worth reporting. Weekends make 2 ordinary. */
  minGapDays?: number;
}

function groupBy<T extends { bankAccountId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.bankAccountId);
    if (list) list.push(row);
    else map.set(row.bankAccountId, [row]);
  }
  return map;
}

/** Whole days between two YYYY-MM-DD dates, computed at UTC so DST cannot shift it. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

export async function getBankStatementCoverage(
  companyId: string,
  options: CoverageOptions,
): Promise<BankStatementCoverage> {
  const { asAt, bankAccountId } = options;
  const minGapDays = options.minGapDays ?? DEFAULT_MIN_GAP_DAYS;

  const [accountRows, monthRows, gapRows, duplicateRows, cash] = await Promise.all([
    fetchCoverageAccounts(companyId, asAt, bankAccountId),
    fetchCoverageMonths(companyId, asAt, bankAccountId),
    fetchCoverageGaps(companyId, asAt, minGapDays, bankAccountId),
    fetchDuplicateReferences(companyId, asAt, bankAccountId),
    // cash.balance.v1 comes from its owning service. Re-deriving the GL side
    // here would create a fifth answer to a question that already had four.
    getCashBalance(companyId, asAt),
  ]);

  const monthsBy = groupBy(monthRows);
  const gapsBy = groupBy(gapRows);
  const dupesBy = groupBy(duplicateRows);
  const glBy = new Map(cash.accounts.map((a) => [a.accountId, a.glBalance]));

  const accounts: BankAccountCoverage[] = accountRows.map((row) => {
    const opening = row.openingBalanceAmount;
    const statementBalance = row.netMovement;
    const computedBalance = (opening ?? 0) + statementBalance;
    // An account the cash figure does not list has no bank-subtype GL presence
    // at all; zero is the honest reading, and the difference then states the
    // whole statement balance as unexplained rather than hiding the row.
    const glBalance = glBy.get(row.bankAccountId) ?? 0;

    return {
      bankAccountId: row.bankAccountId,
      accountCode: row.accountCode,
      accountName: row.accountName,
      isActive: row.isActive,
      firstTransactionDate: row.firstTransactionDate,
      lastTransactionDate: row.lastTransactionDate,
      transactionCount: row.transactionCount,
      netMovement: statementBalance,
      staleDays: row.lastTransactionDate === null
        ? null
        : daysBetween(row.lastTransactionDate, asAt),
      months: (monthsBy.get(row.bankAccountId) ?? []).map(({ bankAccountId: _a, ...rest }) => rest),
      gaps: (gapsBy.get(row.bankAccountId) ?? []).map(({ bankAccountId: _a, ...rest }) => rest),
      duplicateReferences: (dupesBy.get(row.bankAccountId) ?? [])
        .map(({ bankAccountId: _a, ...rest }) => rest),
      openingBalance: { amount: opening, asAt: row.openingBalanceAsAt },
      glBalance,
      statementBalance,
      computedBalance,
      glVsComputedDifference: glBalance - computedBalance,
    };
  });

  const totals = accounts.reduce(
    (acc, a) => ({
      glBalance: acc.glBalance + a.glBalance,
      statementBalance: acc.statementBalance + a.statementBalance,
      computedBalance: acc.computedBalance + a.computedBalance,
      difference: acc.difference + a.glVsComputedDifference,
      transactionCount: acc.transactionCount + a.transactionCount,
    }),
    { glBalance: 0, statementBalance: 0, computedBalance: 0, difference: 0, transactionCount: 0 },
  );

  const newestImport = accountRows.reduce<string | null>(
    (acc, r) => latest(acc, r.latestImportedAt),
    null,
  );

  log.info(
    'Bank statement coverage computed',
    { companyId, asAt, accounts: accounts.length, gaps: gapRows.length },
    'accounting',
  );

  return {
    asAt,
    accounts,
    totals,
    postedThrough: cash.postedThrough ?? newestImport,
  };
}
