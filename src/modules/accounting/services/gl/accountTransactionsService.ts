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
 *
 * Filters: `costCentreId` is EITHER level (cc1_id OR cc2_id, the statement
 * pages' meaning); `opts.cc1Id` / `opts.cc2Id` are EXPLICIT levels (the Budget
 * vs Actual drill, budgets P3 §2.6), ANDed with it and with `businessUnitId`,
 * so a drill opened from a filtered BvA line foots to that line.
 *
 * Budget vs Actual opt-ins (every other caller passes neither, and its output
 * is unchanged):
 *   - `documents`: each posted row carries its journal id and the document the
 *     journal was posted from (`journalDocuments`, one batched read per
 *     document table), so the drill links to it (`lib/journalSourceHref`).
 *   - `naturalSign`: balances signed by account TYPE (revenue credit − debit,
 *     expense debit − credit, as the BvA Actual and the income statement read),
 *     not by the account's own `normal_balance`, so periodNet equals the BvA
 *     line even for an account set to the other normal balance. Balance-sheet
 *     types keep `normal_balance`.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toMoney } from '@/lib/money/decimalSum';
import { assertLedgerRange } from './ledgerDateRange';
import { LedgerAccountNotFoundError } from './ledgerErrors';
import {
  fiscalYearStartsWithin,
  incomeStatementOpeningFloor,
  runWithYearEndCloses,
  yearEndCloseDescription,
} from './fiscalYearCloseRows';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { loadJournalDocuments, type JournalDocumentRef } from './journalDocuments';

export type { JournalDocumentKind, JournalDocumentRef } from './journalDocuments';

type Row = DbRow;

export interface AccountTransactionsOptions {
  /** Explicit dimension levels (the BvA drill), ANDed with the other filters. */
  cc1Id?: string;
  cc2Id?: string;
  /** Attach `journalId` + `document` to each posted row (the BvA drill's source links). */
  documents?: boolean;
  /** Sign by account type (revenue Cr − Dr, expense Dr − Cr) instead of `normal_balance`. */
  naturalSign?: boolean;
}

interface TransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
  /** With `documents`, posted rows only (a derived year-end close row has none). */
  journalId?: string;
  /** With `documents`: the document the journal was posted from; null when none (posted rows only). */
  document?: JournalDocumentRef | null;
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
  opts: AccountTransactionsOptions = {},
): Promise<AccountTransactionsReport> {
  assertLedgerRange(periodStart, periodEnd);
  const cc = costCentreId ?? null;
  const bu = businessUnitId ?? null;
  const cc1 = opts.cc1Id ?? null;
  const cc2 = opts.cc2Id ?? null;
  try {
    const acctRows = (await sql`
      SELECT ga.account_name, ga.account_type, ga.normal_balance
      FROM gl_accounts ga
      WHERE ga.account_code = ${accountCode} AND ga.company_id = ${companyId}::UUID LIMIT 1
    `) as Row[];
    if (!acctRows[0]) throw new LedgerAccountNotFoundError(accountCode);

    const accountType = String(acctRows[0].account_type);
    const natural = opts.naturalSign && (accountType === 'revenue' || accountType === 'expense');
    const normalBal = natural ? (accountType === 'revenue' ? 'credit' : 'debit') : String(acctRows[0].normal_balance);
    const openingFloor = await incomeStatementOpeningFloor(companyId, accountType, periodStart);

    const obRows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND (${cc1}::uuid IS NULL OR jl.cc1_id = ${cc1}::uuid)
        AND (${cc2}::uuid IS NULL OR jl.cc2_id = ${cc2}::uuid)
        AND je.entry_date < ${periodStart}
        AND (${openingFloor}::date IS NULL OR je.entry_date >= ${openingFloor}::date)
        AND ga.account_code = ${accountCode}
    `) as Row[];

    const obDebit = Number(obRows[0]?.total_debit || 0);
    const obCredit = Number(obRows[0]?.total_credit || 0);
    const openingBalance = normalBal === 'debit' ? obDebit - obCredit : obCredit - obDebit;

    const txnRows = (await sql`
      SELECT
        je.id::TEXT AS journal_id, je.entry_date, je.entry_number, je.description, je.source,
        jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND (${cc1}::uuid IS NULL OR jl.cc1_id = ${cc1}::uuid)
        AND (${cc2}::uuid IS NULL OR jl.cc2_id = ${cc2}::uuid)
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_code = ${accountCode}
      ORDER BY je.entry_date, COALESCE(je.created_at, 'epoch'::timestamptz), jl.id
    `) as Row[];

    const docs = opts.documents ? await loadJournalDocuments(companyId, txnRows.map((r) => String(r.journal_id).toLowerCase())) : null;
    const lines: Array<Omit<TransactionRow, 'balance'>> = txnRows.map((r: Row) => {
      const line: Omit<TransactionRow, 'balance'> = {
        date: fmtDate(r.entry_date),
        entryNumber: String(r.entry_number),
        description: String(r.description || ''),
        debit: Number(r.debit || 0),
        credit: Number(r.credit || 0),
        source: String(r.source || 'manual'),
      };
      if (docs) {
        const journalId = String(r.journal_id).toLowerCase();
        line.journalId = journalId;
        line.document = docs.get(journalId) ?? null;
      }
      return line;
    });
    const periodNet = lines.reduce(
      (sum, l) => sum + (normalBal === 'debit' ? l.debit - l.credit : l.credit - l.debit), 0,
    );
    const boundaries = openingFloor ? await fiscalYearStartsWithin(companyId, periodStart, periodEnd) : [];
    const { rows: transactions, closing } = runWithYearEndCloses(lines, {
      opening: openingBalance,
      normalBalance: normalBal,
      boundaries,
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
