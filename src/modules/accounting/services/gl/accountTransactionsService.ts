/**
 * Account Transactions — one account's posted lines for a period, unpaginated.
 * Backs the inline drill-down panel (AccountDrillDown: TB, balance sheet,
 * income statement, budget vs actual) and the account-transactions CSV export.
 *
 * Income-statement accounts open at the start of the fiscal year containing
 * periodStart and close to zero at every fiscal-year start inside the range
 * (gl/fiscalYearCloseRows), so the closing balance is the trial balance's as at
 * periodEnd — the same figure the account-detail page (accountLedgerService)
 * and the GL report show. Balance-sheet accounts are cumulative from inception.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toMoney } from '@/lib/money/decimalSum';
import { DEFAULT_FY_START_MONTH, resolveFiscalYearStartMonth } from './fiscalYearBasis';
import { assertLedgerRange } from './ledgerDateRange';
import { LedgerAccountNotFoundError } from './ledgerErrors';
import {
  fiscalYearStartsWithin,
  incomeStatementOpeningFloor,
  runWithYearEndCloses,
  yearEndCloseDescription,
} from './fiscalYearCloseRows';

type Row = DbRow;

interface TransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
  /** A year-end close row: derived, not posted. */
  derived?: boolean;
}

export interface AccountTransactionsReport {
  accountCode: string;
  accountName: string;
  accountType: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  /** Movement for the period (posted lines only) — equals the income statement's line. */
  periodNet: number;
  closingBalance: number;
  transactions: TransactionRow[];
}

export async function getAccountTransactions(
  companyId: string,
  accountCode: string,
  periodStart: string,
  periodEnd: string,
  costCentreId?: string,
  businessUnitId?: string,
): Promise<AccountTransactionsReport> {
  assertLedgerRange(periodStart, periodEnd);
  const cc = costCentreId ?? null;
  const bu = businessUnitId ?? null;
  try {
    const acctRows = (await sql`
      SELECT ga.account_name, ga.account_type, ga.normal_balance, c.financial_year_start
      FROM gl_accounts ga
      LEFT JOIN companies c ON c.id = ga.company_id
      WHERE ga.account_code = ${accountCode} AND ga.company_id = ${companyId}::UUID LIMIT 1
    `) as Row[];
    if (!acctRows[0]) throw new LedgerAccountNotFoundError(accountCode);

    const normalBal = String(acctRows[0].normal_balance);
    const accountType = String(acctRows[0].account_type);
    // READ PATH: March fallback taken visibly, as the trial balance does.
    const fyStartMonth = resolveFiscalYearStartMonth(
      acctRows[0].financial_year_start, companyId, { fallback: DEFAULT_FY_START_MONTH },
    );
    const openingFloor = incomeStatementOpeningFloor(accountType, periodStart, fyStartMonth);

    const obRows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
          OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND je.entry_date < ${periodStart}
        AND (${openingFloor}::date IS NULL OR je.entry_date >= ${openingFloor}::date)
        AND ga.account_code = ${accountCode}
    `) as Row[];

    const obDebit = Number(obRows[0]?.total_debit || 0);
    const obCredit = Number(obRows[0]?.total_credit || 0);
    const openingBalance = normalBal === 'debit' ? obDebit - obCredit : obCredit - obDebit;

    const txnRows = (await sql`
      SELECT
        je.entry_date, je.entry_number, je.description, je.source,
        jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
          OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_code = ${accountCode}
      ORDER BY je.entry_date, COALESCE(je.created_at, 'epoch'::timestamptz), jl.id
    `) as Row[];

    const lines = txnRows.map((r: Row) => ({
      date: fmtDate(r.entry_date),
      entryNumber: String(r.entry_number),
      description: String(r.description || ''),
      debit: Number(r.debit || 0),
      credit: Number(r.credit || 0),
      source: String(r.source || 'manual'),
    }));
    const periodNet = lines.reduce(
      (sum, l) => sum + (normalBal === 'debit' ? l.debit - l.credit : l.credit - l.debit), 0,
    );
    const { rows: transactions, closing } = runWithYearEndCloses(lines, {
      opening: openingBalance,
      normalBalance: normalBal,
      boundaries: openingFloor ? fiscalYearStartsWithin(periodStart, periodEnd, fyStartMonth) : [],
      makeClose: (fyEnd, { debit, credit }) => ({
        date: fyEnd, entryNumber: '', description: yearEndCloseDescription(fyEnd),
        debit, credit, source: 'year_end_close', derived: true,
      }),
    });

    return {
      accountCode,
      accountName: String(acctRows[0].account_name),
      accountType,
      periodStart,
      periodEnd,
      openingBalance: toMoney(openingBalance),
      periodNet: toMoney(periodNet),
      closingBalance: toMoney(closing),
      transactions: transactions.map(t => ({ ...t, balance: toMoney(t.balance) })),
    };
  } catch (err) {
    // An unknown account is an expected refusal (a 404 upstream), not an error event.
    if (err instanceof LedgerAccountNotFoundError) log.warn('Account transactions: account not found', { error: err }, 'accounting');
    else log.error('Failed to generate account transactions', { error: err }, 'accounting');
    throw err;
  }
}
