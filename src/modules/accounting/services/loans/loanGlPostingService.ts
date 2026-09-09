import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { ScheduleRow } from '@/lib/amortisation/types';

type Row = DbRow;

export interface LoanGlAccounts {
  loanLiability: string;
  interestExpense: string;
  interestPayable: string;
  bank: string;
  currentPortion: string;
}

export interface LoanGlPosting {
  id: string;
  companyId: string;
  loanId: string;
  period: number;
  postingDate: string;
  accountId: string;
  debit: number;
  credit: number;
  narrative: string | null;
  postedPeriod: string | null;
  reversalOf: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

export interface PostPeriodResult {
  loanId: string;
  period: number;
  journalEntryId: string;
  narrative: string;
}

// ── Pure journal builder ─────────────────────────────────────────────────────

export function buildPeriodJournalInput(
  row: ScheduleRow,
  accounts: LoanGlAccounts,
  narrative: string,
): JournalEntryCreateInput {
  const lines: JournalLineInput[] = [];

  if (row.skip) {
    // Interest accrues to payable account, no bank leg
    lines.push({ glAccountId: accounts.interestExpense, debit: row.interest, credit: 0, description: narrative });
    lines.push({ glAccountId: accounts.interestPayable, debit: 0, credit: row.interest, description: narrative });
  } else {
    // Raw (signed) principal portion: when payment < interest, principal is negative
    // which means the loan liability grows (Cr instead of Dr). Keeping the sign
    // preserves the debit-credit balance across every cashflow case.
    const principalPaid = row.payment - row.interest;
    const bankOut = row.payment + row.lump;

    if (row.interest > 0) {
      lines.push({ glAccountId: accounts.interestExpense, debit: row.interest, credit: 0, description: narrative });
    }
    if (principalPaid > 0) {
      lines.push({ glAccountId: accounts.loanLiability, debit: principalPaid, credit: 0, description: narrative });
    } else if (principalPaid < 0) {
      lines.push({ glAccountId: accounts.loanLiability, debit: 0, credit: -principalPaid, description: `${narrative} – interest capitalised` });
    }
    if (row.lump > 0) {
      lines.push({ glAccountId: accounts.loanLiability, debit: row.lump, credit: 0, description: `${narrative} – lump` });
    }
    if (bankOut > 0) {
      lines.push({ glAccountId: accounts.bank, debit: 0, credit: bankOut, description: narrative });
    }
  }

  return {
    entryDate: row.date,
    description: narrative,
    source: 'manual',
    lines,
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function extractAccounts(loanRow: Row): LoanGlAccounts {
  const loanLiability = loanRow.gl_account_id != null ? String(loanRow.gl_account_id) : '';
  const interestExpense = loanRow.interest_expense_account_id != null ? String(loanRow.interest_expense_account_id) : '';
  const interestPayable = loanRow.interest_payable_account_id != null ? String(loanRow.interest_payable_account_id) : '';
  const bank = loanRow.bank_account_id != null ? String(loanRow.bank_account_id) : '';
  const currentPortion = loanRow.current_portion_account_id != null ? String(loanRow.current_portion_account_id) : '';
  if (!loanLiability || !interestExpense || !interestPayable || !bank || !currentPortion) {
    throw new Error(
      'Loan is missing one or more required GL accounts (loan liability, interest expense, interest payable, bank, current portion)',
    );
  }
  return { loanLiability, interestExpense, interestPayable, bank, currentPortion };
}

function yyyymm(date: string): string {
  return date.slice(0, 7).replace('-', '');
}

function dbRowToSchedule(r: Row): ScheduleRow {
  const interest = parseFloat(String(r.interest ?? '0'));
  return {
    period: Number(r.period),
    date: fmtDate(r.date),
    opening: parseFloat(String(r.opening ?? '0')),
    rate: parseFloat(String(r.rate ?? '0')),
    installment: parseFloat(String(r.installment ?? '0')),
    interest,
    principal: parseFloat(String(r.principal ?? '0')),
    intPortion: interest,
    skip: Boolean(r.skip_flag),
    payment: parseFloat(String(r.payment ?? '0')),
    lump: parseFloat(String(r.lump ?? '0')),
    closing: parseFloat(String(r.closing ?? '0')),
    stLiability: parseFloat(String(r.st_liability ?? '0')),
    extrapolated: Boolean(r.extrapolated),
    nca_flagged: Boolean(r.nca_flagged),
  };
}

function mapPostingRow(r: Row): LoanGlPosting {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    loanId: String(r.loan_id),
    period: Number(r.period),
    postingDate: fmtDate(r.posting_date),
    accountId: String(r.account_id),
    debit: parseFloat(String(r.debit ?? '0')),
    credit: parseFloat(String(r.credit ?? '0')),
    narrative: r.narrative != null ? String(r.narrative) : null,
    postedPeriod: r.posted_period != null ? String(r.posted_period) : null,
    reversalOf: r.reversal_of != null ? String(r.reversal_of) : null,
    journalEntryId: r.journal_entry_id != null ? String(r.journal_entry_id) : null,
    createdAt: String(r.created_at),
  };
}

// ── postPeriodJournals ──────────────────────────────────────────────────────

export async function postPeriodJournals(
  companyId: string,
  loanId: string,
  period: number,
  userId: string,
): Promise<PostPeriodResult> {
  // FOR UPDATE serialises two concurrent posts of the same loan; the
  // already-posted check below then sees the winner's committed rows.
  const loans = (await sql`
    SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId} FOR UPDATE
  `) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);

  const loanRow = loans[0]!;
  const accounts = extractAccounts(loanRow);

  // Find the latest schedule run for this loan
  const runs = (await sql`
    SELECT id FROM loan_schedule_runs WHERE loan_id = ${loanId} ORDER BY computed_at DESC LIMIT 1
  `) as Row[];
  if (runs.length === 0) throw new Error('No schedule run exists — compute schedule first');

  const runId = String(runs[0]!.id);
  const rows = (await sql`
    SELECT * FROM loan_schedule_rows WHERE run_id = ${runId} AND period = ${period}
  `) as Row[];
  if (rows.length === 0) throw new Error(`Schedule row for period ${period} not found`);

  const row = dbRowToSchedule(rows[0]!);
  const yyyymmStr = yyyymm(row.date);

  // Block posting if NCA in-duplum breached for this period
  if (row.nca_flagged) {
    throw new Error(
      `NCA in-duplum breach flagged for period ${period} — resolve compliance issue before posting journals`,
    );
  }

  // Check if period is locked
  const locks = (await sql`
    SELECT yyyymm FROM loan_period_locks WHERE company_id = ${companyId} AND yyyymm = ${yyyymmStr}
  `) as Row[];
  if (locks.length > 0) throw new Error(`Period ${yyyymmStr} is locked`);

  // Already posted? A row carrying reversal_of is a reversal, not a posting,
  // and does not block. The ORIGINAL rows keep reversal_of IS NULL and DO
  // block, including after they have been reversed in the GL — reversing a
  // journal writes to gl_journal_entries only and leaves these rows untouched.
  // Re-posting a period therefore requires deleting or re-pointing its
  // loan_gl_postings rows first; see docs/audits/remediation/K-083/fix.md.
  //
  // `journal_entry_id IS NOT NULL` keeps this in step with the exclusion
  // constraint in migration 644, whose predicate carries the same test.
  const posted = (await sql`
    SELECT journal_entry_id FROM loan_gl_postings
    WHERE company_id = ${companyId} AND loan_id = ${loanId} AND period = ${period}
      AND reversal_of IS NULL AND journal_entry_id IS NOT NULL
    LIMIT 1
  `) as Row[];
  if (posted.length > 0) {
    throw new Error(
      `Period ${period} of loan ${loanId} has already been posted (journal ${String(posted[0]!.journal_entry_id)})`,
    );
  }

  const narrative = `Loan ${String(loanRow.reference ?? loanId)} – period ${period}`;
  const entryInput = buildPeriodJournalInput(row, accounts, narrative);

  const entry = await createJournalEntry(companyId, entryInput, userId);
  await postJournalEntry(companyId, entry.id, userId);

  // Record each line in loan_gl_postings for reporting/reversal
  for (const line of entryInput.lines) {
    await sql`
      INSERT INTO loan_gl_postings
        (company_id, loan_id, period, posting_date, account_id,
         debit, credit, narrative, posted_period, journal_entry_id)
      VALUES
        (${companyId}, ${loanId}, ${period}, ${row.date}, ${line.glAccountId},
         ${line.debit}, ${line.credit}, ${narrative}, ${yyyymmStr}, ${entry.id})
    `;
  }

  log.info('Posted loan period journals', { loanId, period, entryId: entry.id }, 'loans');
  return { loanId, period, journalEntryId: entry.id, narrative };
}

// ── getLoanGlPostings ──────────────────────────────────────────────────────

export async function getLoanGlPostings(
  companyId: string,
  loanId: string,
): Promise<LoanGlPosting[]> {
  const rows = (await sql`
    SELECT * FROM loan_gl_postings
    WHERE company_id = ${companyId} AND loan_id = ${loanId}
    ORDER BY posting_date ASC, period ASC
  `) as Row[];
  return rows.map(mapPostingRow);
}
