// Loan Payment Service
// DR current_portion_account (principal) + DR interest_expense (interest) = CR bank (total)
// Interest falls back to GL 5700 (Bank Charges) when not set on the loan.
// Idempotency: duplicate (company, loan, period) raises "already recorded" error.

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';

type Row = DbRow;

// ── Public types ─────────────────────────────────────────────────────────────

export interface LoanPaymentInput {
  paymentDate: string;    // yyyy-mm-dd
  periodNumber?: number;  // Omit to match by month
  bankAccountId?: string; // Override loan's default bank GL account
}

export interface LoanPaymentResult {
  paymentId: string;
  journalEntryId: string;
  principal: number;
  interest: number;
  totalPaid: number;
  newOutstanding: number;
}

export interface LoanPayment {
  id: string;
  companyId: string;
  loanId: string;
  paymentDate: string;
  periodNumber: number | null;
  amount: number;
  principal: number;
  interest: number;
  bankAccountId: string | null;
  journalEntryId: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const toDate = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const num = (v: unknown): number => parseFloat(String(v ?? '0'));

function mapPaymentRow(r: Row): LoanPayment {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    loanId: String(r.loan_id),
    paymentDate: toDate(r.payment_date),
    periodNumber: r.period_number != null ? Number(r.period_number) : null,
    amount: num(r.amount),
    principal: num(r.principal),
    interest: num(r.interest),
    bankAccountId: r.bank_account_id != null ? String(r.bank_account_id) : null,
    journalEntryId: r.journal_entry_id != null ? String(r.journal_entry_id) : null,
    createdBy: r.created_by != null ? String(r.created_by) : null,
    createdAt: String(r.created_at),
  };
}

async function glByCode(companyId: string, code: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${companyId} AND code = ${code} LIMIT 1
  `) as Row[];
  return rows.length > 0 ? String(rows[0]!.id) : null;
}

interface ResolvedAccounts {
  debitLoan: string;      // current_portion (or long-term liability fallback)
  debitInterest: string;  // interest expense (or 5700 fallback)
  creditBank: string;     // bank GL account
}

async function resolveAccounts(
  companyId: string,
  loanRow: Row,
  bankAccountIdOverride: string | undefined,
): Promise<ResolvedAccounts> {
  // Prefer current_portion_account_id (period-close reclassified it); fall back to gl_account_id
  const debitLoan =
    loanRow.current_portion_account_id != null ? String(loanRow.current_portion_account_id)
    : loanRow.gl_account_id != null ? String(loanRow.gl_account_id)
    : null;
  if (!debitLoan) throw new Error('Loan has no GL account (gl_account_id / current_portion_account_id)');

  // Interest expense: loan column → code 5700 (Bank Charges — demo fallback)
  let debitInterest: string | null = loanRow.interest_expense_account_id != null
    ? String(loanRow.interest_expense_account_id) : null;
  if (!debitInterest) {
    debitInterest = await glByCode(companyId, '5700');
    log.warn('interest_expense_account_id not set — using GL 5700 (Bank Charges)',
      { loanId: String(loanRow.id), companyId }, 'loans');
  }
  if (!debitInterest) throw new Error('Cannot resolve interest expense account (set on loan or add GL 5700)');

  // Bank: override → loan.bank_account_id → code 1110
  let creditBank: string | null = bankAccountIdOverride ?? null;
  if (!creditBank && loanRow.bank_account_id != null) creditBank = String(loanRow.bank_account_id);
  if (!creditBank) {
    creditBank = await glByCode(companyId, '1110');
    log.warn('No bank account resolved — using GL 1110', { loanId: String(loanRow.id), companyId }, 'loans');
  }
  if (!creditBank) throw new Error('Cannot resolve bank GL account (supply bankAccountId or add GL 1110)');

  return { debitLoan, debitInterest, creditBank };
}

// ── buildPaymentJournalInput (pure / exported for tests) ─────────────────────

export function buildPaymentJournalInput(
  principal: number,
  interest: number,
  total: number,
  accounts: ResolvedAccounts,
  paymentDate: string,
  narrative: string,
): JournalEntryCreateInput {
  const lines: JournalLineInput[] = [];

  if (principal > 0) {
    lines.push({
      glAccountId: accounts.debitLoan,
      debit: principal,
      credit: 0,
      description: `${narrative} – principal`,
    });
  }

  if (interest > 0) {
    lines.push({
      glAccountId: accounts.debitInterest,
      debit: interest,
      credit: 0,
      description: `${narrative} – interest`,
    });
  }

  lines.push({
    glAccountId: accounts.creditBank,
    debit: 0,
    credit: total,
    description: narrative,
  });

  return { entryDate: paymentDate, description: narrative, source: 'manual', lines };
}

// ── recordLoanPayment ────────────────────────────────────────────────────────

export async function recordLoanPayment(
  companyId: string,
  loanId: string,
  input: LoanPaymentInput,
  userId: string,
): Promise<LoanPaymentResult> {
  // 1. Load + validate loan
  const loans = (await sql`
    SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId}
  `) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);
  const loanRow = loans[0]!;
  if (String(loanRow.status) !== 'active')
    throw new Error(`Cannot record payment on loan with status '${String(loanRow.status)}'`);

  // 2. Idempotency — block duplicate period
  if (input.periodNumber != null) {
    const dup = (await sql`
      SELECT id FROM loan_payments
      WHERE company_id = ${companyId} AND loan_id = ${loanId} AND period_number = ${input.periodNumber}
    `) as Row[];
    if (dup.length > 0) throw new Error(`Payment for period ${input.periodNumber} already recorded`);
  }

  // 3. Find schedule row (by period or by payment month)
  const payMonth = input.paymentDate.slice(0, 7).replace('-', '');
  const scheduleRows = input.periodNumber != null
    ? (await sql`
        SELECT lsr.* FROM loan_schedule_rows lsr
        JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
        WHERE lsrun.loan_id = ${loanId} AND lsrun.company_id = ${companyId}
          AND lsr.period = ${input.periodNumber}
        ORDER BY lsrun.computed_at DESC NULLS LAST LIMIT 1
      `) as Row[]
    : (await sql`
        SELECT lsr.* FROM loan_schedule_rows lsr
        JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
        WHERE lsrun.loan_id = ${loanId} AND lsrun.company_id = ${companyId}
          AND TO_CHAR(lsr.date, 'YYYYMM') = ${payMonth}
        ORDER BY lsrun.computed_at DESC NULLS LAST, lsr.period ASC LIMIT 1
      `) as Row[];

  if (scheduleRows.length === 0) {
    const hint = input.periodNumber != null ? `period ${input.periodNumber}` : `month ${payMonth}`;
    throw new Error(`No schedule row found for ${hint} — compute schedule first`);
  }

  const sr = scheduleRows[0]!;
  const interest = num(sr.interest);
  const principal = num(sr.opening) - num(sr.closing); // opening − closing = principal paid
  const totalPaid = num(sr.installment) > 0 ? num(sr.installment) : interest + principal;
  const newOutstanding = num(sr.closing);
  const periodNumber = input.periodNumber ?? Number(sr.period);

  if (totalPaid <= 0)
    throw new Error(`Schedule row has zero total payment — verify schedule for period ${periodNumber}`);

  // Cent-level balance guard before posting
  if (Math.round((principal + interest) * 100) !== Math.round(totalPaid * 100)) {
    throw new Error(
      `Journal imbalance: DR ${(principal + interest).toFixed(2)} ≠ CR ${totalPaid.toFixed(2)} for period ${periodNumber}`,
    );
  }

  // 4. Resolve GL accounts
  const accounts = await resolveAccounts(companyId, loanRow, input.bankAccountId);

  // 5. Build journal + post
  const paymentDate = input.paymentDate;
  const narrative = `Loan payment – ${String(loanRow.reference ?? loanId)} period ${periodNumber}`;
  const entry = await createJournalEntry(
    companyId,
    buildPaymentJournalInput(principal, interest, totalPaid, accounts, paymentDate, narrative),
    userId,
  );
  await postJournalEntry(companyId, entry.id, userId);

  // 6. Persist
  const payRows = (await sql`
    INSERT INTO loan_payments
      (company_id, loan_id, payment_date, period_number, amount,
       principal, interest, bank_account_id, journal_entry_id, created_by)
    VALUES (${companyId}, ${loanId}, ${paymentDate}, ${periodNumber},
            ${totalPaid}, ${principal}, ${interest},
            ${accounts.creditBank}, ${entry.id}, ${userId})
    RETURNING id
  `) as Row[];

  const paymentId = String(payRows[0]!.id);
  log.info('Recorded loan payment',
    { companyId, loanId, periodNumber, paymentId, journalEntryId: entry.id, principal, interest, totalPaid },
    'loans');

  return { paymentId, journalEntryId: entry.id, principal, interest, totalPaid, newOutstanding };
}

// ── listLoanPayments ─────────────────────────────────────────────────────────

export async function listLoanPayments(
  companyId: string,
  loanId: string,
): Promise<LoanPayment[]> {
  const rows = (await sql`
    SELECT * FROM loan_payments
    WHERE company_id = ${companyId} AND loan_id = ${loanId}
    ORDER BY payment_date ASC, period_number ASC NULLS LAST
  `) as Row[];
  return rows.map(mapPaymentRow);
}
