import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { LoanGlAccounts } from './loanGlPostingService';
import {
  buildReclassificationInput,
  fetchPriorReclass,
  recordReclass,
} from './loanReclassService';
import type { SnapshotRow } from './loanReclassService';
import { assertClosesInOrder, assertFiscalPeriodResolved } from './loanPostingGuards';

export { buildReclassificationInput } from './loanReclassService';
export type { SnapshotRow } from './loanReclassService';

type Row = DbRow;

export interface PeriodLock {
  companyId: string;
  yyyymm: string;
  lockedAt: string;
  lockedBy: string | null;
}

export interface LoanPeriodStatus {
  loanId: string;
  reference: string | null;
  description: string | null;
  product: string | null;
  principalBalance: number;
  rateMode: string;
  margin: number;
  fixedRate: number | null;
  nextPaymentDate: string | null;
  accruedInterest: number;
  /** 'posted' if loan_gl_postings row exists for the period, else 'open' */
  periodStatus: 'open' | 'posted';
}

export interface SkippedLoan {
  loanId: string;
  reason: string;
}

export interface CloseResult {
  yyyymm: string;
  loansProcessed: number;
  reclassEntries: string[];
  locked: boolean;
  skippedLoans?: SkippedLoan[];
}

// ── lock helpers ────────────────────────────────────────────────────────────

export async function isPeriodLocked(companyId: string, yyyymm: string): Promise<boolean> {
  const rows = (await sql`
    SELECT yyyymm FROM loan_period_locks WHERE company_id = ${companyId} AND yyyymm = ${yyyymm}
  `) as Row[];
  return rows.length > 0;
}

function mapLock(r: Row): PeriodLock {
  return {
    companyId: String(r.company_id),
    yyyymm: String(r.yyyymm),
    lockedAt: String(r.locked_at),
    lockedBy: r.locked_by != null ? String(r.locked_by) : null,
  };
}

export async function lockPeriod(
  companyId: string,
  yyyymm: string,
  userId: string,
): Promise<PeriodLock> {
  const existing = (await sql`
    SELECT yyyymm FROM loan_period_locks WHERE company_id = ${companyId} AND yyyymm = ${yyyymm}
  `) as Row[];
  if (existing.length > 0) throw new Error(`Period ${yyyymm} is already locked`);

  const rows = (await sql`
    INSERT INTO loan_period_locks (company_id, yyyymm, locked_at, locked_by)
    VALUES (${companyId}, ${yyyymm}, now(), ${userId})
    RETURNING *
  `) as Row[];
  log.info('Locked loan period', { companyId, yyyymm, userId }, 'loans');
  return mapLock(rows[0]!);
}

// ── closeLoanPeriod ─────────────────────────────────────────────────────────

function extractAccounts(loanRow: Row): LoanGlAccounts | null {
  const ids = [
    loanRow.gl_account_id,
    loanRow.interest_expense_account_id,
    loanRow.interest_payable_account_id,
    loanRow.bank_account_id,
    loanRow.current_portion_account_id,
  ];
  if (ids.some((v) => v == null)) return null;
  return {
    loanLiability: String(loanRow.gl_account_id),
    interestExpense: String(loanRow.interest_expense_account_id),
    interestPayable: String(loanRow.interest_payable_account_id),
    bank: String(loanRow.bank_account_id),
    currentPortion: String(loanRow.current_portion_account_id),
  };
}

export async function closeLoanPeriod(
  companyId: string,
  yyyymm: string,
  userId: string,
): Promise<CloseResult> {
  if (await isPeriodLocked(companyId, yyyymm)) {
    throw new Error(`Period ${yyyymm} is already locked`);
  }
  await assertClosesInOrder(companyId, yyyymm);

  // One JOINed query: every active loan with its latest schedule-row snapshot
  // for the target month. LEFT JOIN on LATERAL so loans with no row in this
  // period still come back (and get skipped below). Replaces the previous
  // O(N) per-loan query.
  const rows = (await sql`
    SELECT l.*,
           snap.closing     AS snapshot_closing,
           snap.st_liability AS snapshot_stliability,
           snap.date        AS snapshot_date
    FROM loans l
    LEFT JOIN LATERAL (
      SELECT lsr.closing, lsr.st_liability, lsr.date
      FROM loan_schedule_rows lsr
      JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
      WHERE lsrun.loan_id = l.id
        AND lsrun.company_id = ${companyId}
        AND TO_CHAR(lsr.date, 'YYYYMM') = ${yyyymm}
      ORDER BY lsrun.computed_at DESC NULLS LAST, lsr.period DESC
      LIMIT 1
    ) snap ON true
    WHERE l.company_id = ${companyId} AND l.status = 'active'
  `) as Row[];

  // What the previous close actually posted for each loan. A month can be
  // locked without this loan having been reclassified in it, so the lock is
  // not evidence; only a recorded reclass is.
  const priorByLoan = await fetchPriorReclass(companyId, yyyymm);

  const reclassEntries: string[] = [];
  const skippedLoans: SkippedLoan[] = [];

  for (const row of rows) {
    const loanId = String(row.id);
    const accounts = extractAccounts(row);
    if (!accounts) {
      skippedLoans.push({ loanId, reason: 'missing GL accounts' });
      log.warn('Skipping loan without GL accounts', { loanId, yyyymm }, 'loans');
      continue;
    }

    if (row.snapshot_closing == null || row.snapshot_date == null) {
      skippedLoans.push({ loanId, reason: 'no schedule row for period' });
      continue;
    }

    const snapshot: SnapshotRow = {
      closing: parseFloat(String(row.snapshot_closing)),
      stLiability: parseFloat(String(row.snapshot_stliability ?? '0')),
      priorStLiability: priorByLoan.get(loanId) ?? 0,
    };
    const postingDate = fmtDate(row.snapshot_date);
    const narrative = `Reclassification – loan ${String(row.reference ?? loanId)} for ${yyyymm}`;

    const input = buildReclassificationInput(snapshot, accounts, postingDate, narrative);
    if (input.lines.length === 0) continue;

    const entry = await createJournalEntry(companyId, input, userId);
    assertFiscalPeriodResolved(entry.fiscalPeriodId, postingDate, narrative);
    await postJournalEntry(companyId, entry.id, userId);
    await recordReclass(companyId, loanId, yyyymm, snapshot.stLiability, entry.id);
    reclassEntries.push(entry.id);
  }

  await sql`
    INSERT INTO loan_period_locks (company_id, yyyymm, locked_at, locked_by)
    VALUES (${companyId}, ${yyyymm}, now(), ${userId})
  `;

  log.info(
    'Closed loan period',
    { companyId, yyyymm, loans: rows.length, reclass: reclassEntries.length, skipped: skippedLoans.length },
    'loans',
  );

  const result: CloseResult = {
    yyyymm,
    loansProcessed: rows.length,
    reclassEntries,
    locked: true,
  };
  if (skippedLoans.length > 0) result.skippedLoans = skippedLoans;
  return result;
}

// ── listLoansForPeriodClose ─────────────────────────────────────────────────

/**
 * Returns every active loan with:
 *  - latest closing balance for the target period (from the most recent schedule run)
 *  - accrued interest for the period
 *  - next payment date (first schedule row after the period)
 *  - posting status for the period
 */
export async function listLoansForPeriodClose(
  companyId: string,
  targetYyyymm: string,
): Promise<LoanPeriodStatus[]> {
  const rows = (await sql`
    SELECT
      l.id                          AS loan_id,
      l.reference,
      l.description,
      l.product,
      l.rate_mode,
      l.margin,
      l.fixed_rate,
      COALESCE(snap.closing, l.principal)  AS principal_balance,
      COALESCE(snap.interest, 0)           AS accrued_interest,
      next_pay.date                         AS next_payment_date,
      CASE WHEN post.loan_id IS NOT NULL THEN 'posted' ELSE 'open' END AS period_status
    FROM loans l
    -- Latest schedule row for this period (most recent run wins)
    LEFT JOIN LATERAL (
      SELECT lsr.closing, lsr.interest, lsr.date
      FROM loan_schedule_rows lsr
      JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
      WHERE lsrun.loan_id = l.id
        AND TO_CHAR(lsr.date, 'YYYYMM') = ${targetYyyymm}
        AND lsrun.company_id = ${companyId}
      ORDER BY lsrun.computed_at DESC NULLS LAST
      LIMIT 1
    ) snap ON true
    -- Next payment date after the period
    LEFT JOIN LATERAL (
      SELECT lsr2.date
      FROM loan_schedule_rows lsr2
      JOIN loan_schedule_runs lsrun2 ON lsrun2.id = lsr2.run_id
      WHERE lsrun2.loan_id = l.id
        AND lsrun2.company_id = ${companyId}
        AND TO_CHAR(lsr2.date, 'YYYYMM') > ${targetYyyymm}
        AND lsr2.skip_flag = false
      ORDER BY lsrun2.computed_at DESC NULLS LAST, lsr2.date ASC
      LIMIT 1
    ) next_pay ON true
    -- Check if any GL posting already exists for this loan + period
    LEFT JOIN (
      SELECT DISTINCT loan_id
      FROM loan_gl_postings
      WHERE company_id = ${companyId}
        AND posted_period = ${targetYyyymm}
    ) post ON post.loan_id = l.id
    WHERE l.company_id = ${companyId} AND l.status = 'active'
    ORDER BY l.reference ASC NULLS LAST, l.created_at ASC
  `) as Row[];

  return rows.map((r) => ({
    loanId: String(r.loan_id),
    reference: r.reference != null ? String(r.reference) : null,
    description: r.description != null ? String(r.description) : null,
    product: r.product != null ? String(r.product) : null,
    principalBalance: parseFloat(String(r.principal_balance ?? '0')),
    rateMode: String(r.rate_mode),
    margin: parseFloat(String(r.margin ?? '0')),
    fixedRate: r.fixed_rate != null ? parseFloat(String(r.fixed_rate)) : null,
    nextPaymentDate:
      r.next_payment_date != null ? fmtDate(r.next_payment_date) : null,
    accruedInterest: parseFloat(String(r.accrued_interest ?? '0')),
    periodStatus: (r.period_status === 'posted' ? 'posted' : 'open') as 'open' | 'posted',
  }));
}
