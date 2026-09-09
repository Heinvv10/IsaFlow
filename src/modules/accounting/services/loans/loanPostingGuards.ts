/**
 * Guards shared by the two loan paths that write to the general ledger:
 * `closeLoanPeriod` (the current-portion reclass) and `postPeriodJournals`
 * (the contractual instalment journal).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

type Row = DbRow;

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Raised when another request holds the loan row past the 5s `lock_timeout`. */
export class LoanPostLockTimeoutError extends Error {
  readonly code = 'LOAN_POST_LOCK_TIMEOUT';
  constructor(loanId: string) {
    super(`Loan ${loanId} is being posted by another request — retry in a moment.`);
    this.name = 'LoanPostLockTimeoutError';
  }
}

/**
 * Read one loan for a company and hold a row lock on it for the rest of the
 * request transaction, so two concurrent posts of the same period serialise
 * and the second sees the first's committed `loan_gl_postings` rows.
 *
 * Bounded, per `bankTxLock.ts`: an unbounded `FOR UPDATE` behind a peer that
 * is wedged pins the connection until the HTTP/pool timeout. `SET LOCAL` is
 * subtransaction-aware and reverts to `0` on `ROLLBACK TO SAVEPOINT`, so it is
 * re-issued on every call rather than memoised. Returns `null` when the loan
 * does not exist or belongs to another tenant.
 */
export async function lockLoanForUpdate(
  companyId: string,
  loanId: string,
): Promise<Row | null> {
  const client = als.getStore()?.client;
  if (client) {
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }
  try {
    const rows = (await sql`
      SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId} FOR UPDATE
    `) as Row[];
    return rows[0] ?? null;
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new LoanPostLockTimeoutError(loanId);
    }
    throw err;
  }
}

/**
 * Review M2. The reclass journals only the MOVEMENT since the previous close,
 * and `fetchPriorReclass` reads the latest EARLIER record, never a later one.
 * Closing a month after a later month has already closed therefore reads a
 * prior of 0, posts the FULL current portion, and no subsequent close unwinds
 * it — the account stays permanently over by that amount. The invariant "the
 * current-portion account holds the last recorded st_liability" only holds
 * while months close in ascending order, so refuse the out-of-order close
 * rather than silently breaking it.
 */
export async function assertClosesInOrder(companyId: string, yyyymm: string): Promise<void> {
  const later = (await sql`
    SELECT yyyymm FROM loan_period_locks
    WHERE company_id = ${companyId} AND yyyymm > ${yyyymm}
    ORDER BY yyyymm ASC LIMIT 1
  `) as Row[];
  if (later.length > 0) {
    throw new Error(
      `Period ${yyyymm} cannot be closed after ${String(later[0]!.yyyymm).trim()} — `
      + 'loan periods must be closed in ascending order',
    );
  }
}

/**
 * Review L6. `createJournalEntry` falls back to a NULL `fiscal_period_id` when
 * the entry date lies outside the auto-create window (10 years back, 2 years
 * forward), and `postJournalEntry` guards its closed-period check behind
 * `if (entry.fiscalPeriodId)`. A long loan's schedule runs well past +2 years,
 * and the close route accepts any six digits, so both paths could post a
 * journal that never appears in the trial balance, VAT201 or the AFS. Refuse
 * instead — the throw rolls the request transaction back, so nothing posts.
 */
export function assertFiscalPeriodResolved(
  fiscalPeriodId: string | undefined,
  entryDate: string,
  narrative: string,
): void {
  if (!fiscalPeriodId) {
    throw new Error(
      `${narrative}: ${entryDate} falls outside every fiscal period and none could be created `
      + '— open the fiscal year before posting, or the entry would sit outside every report',
    );
  }
}
