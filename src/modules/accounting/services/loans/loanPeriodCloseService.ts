import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { LoanGlAccounts } from './loanGlPostingService';

type Row = DbRow;

export interface PeriodLock {
  companyId: string;
  yyyymm: string;
  lockedAt: string;
  lockedBy: string | null;
}

export interface CloseResult {
  yyyymm: string;
  loansProcessed: number;
  reclassEntries: string[];
  locked: boolean;
}

interface SnapshotRow {
  closing: number;
  stLiability: number;
}

// ── buildReclassificationInput (pure) ───────────────────────────────────────

export function buildReclassificationInput(
  snapshot: SnapshotRow,
  accounts: LoanGlAccounts,
  postingDate: string,
  narrative: string,
): JournalEntryCreateInput {
  const lines: JournalLineInput[] = [];
  if (snapshot.stLiability > 0) {
    lines.push({ glAccountId: accounts.loanLiability, debit: snapshot.stLiability, credit: 0, description: narrative });
    lines.push({ glAccountId: accounts.currentPortion, debit: 0, credit: snapshot.stLiability, description: narrative });
  }
  return { entryDate: postingDate, description: narrative, source: 'manual', lines };
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

  const loans = (await sql`
    SELECT * FROM loans WHERE company_id = ${companyId} AND status = 'active'
  `) as Row[];

  const reclassEntries: string[] = [];

  for (const loanRow of loans) {
    const accounts = extractAccounts(loanRow);
    if (!accounts) {
      log.warn('Skipping loan without GL accounts', { loanId: String(loanRow.id), yyyymm }, 'loans');
      continue;
    }

    // Find the period-end schedule row (last row whose month matches yyyymm)
    const periodRows = (await sql`
      SELECT lsr.closing, lsr.st_liability, lsr.date
      FROM loan_schedule_rows lsr
      JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
      WHERE lsrun.loan_id = ${String(loanRow.id)}
        AND TO_CHAR(lsr.date, 'YYYYMM') = ${yyyymm}
      ORDER BY lsr.computed_at DESC NULLS LAST, lsr.period DESC
      LIMIT 1
    `) as Row[];

    if (periodRows.length === 0) continue;

    const snapshot: SnapshotRow = {
      closing: parseFloat(String(periodRows[0]!.closing ?? '0')),
      stLiability: parseFloat(String(periodRows[0]!.st_liability ?? '0')),
    };
    const postingDate = String(periodRows[0]!.date).slice(0, 10);
    const narrative = `Reclassification – loan ${String(loanRow.reference ?? loanRow.id)} for ${yyyymm}`;

    const input = buildReclassificationInput(snapshot, accounts, postingDate, narrative);
    if (input.lines.length === 0) continue;

    const entry = await createJournalEntry(companyId, input, userId);
    await postJournalEntry(companyId, entry.id, userId);
    reclassEntries.push(entry.id);
  }

  await sql`
    INSERT INTO loan_period_locks (company_id, yyyymm, locked_at, locked_by)
    VALUES (${companyId}, ${yyyymm}, now(), ${userId})
  `;

  log.info('Closed loan period', { companyId, yyyymm, loans: loans.length, reclass: reclassEntries.length }, 'loans');
  return { yyyymm, loansProcessed: loans.length, reclassEntries, locked: true };
}
