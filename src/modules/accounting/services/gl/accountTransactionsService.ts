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
 * pages' meaning); `dims.cc1Id` / `dims.cc2Id` are EXPLICIT levels (the Budget
 * vs Actual drill, budgets P3 §2.6), ANDed with it and with `businessUnitId`,
 * so a drill opened from a filtered BvA line foots to that line.
 *
 * Each posted row carries its journal id and, when the journal was posted from
 * a document (customer invoice / credit note / payment, supplier invoice /
 * payment), that document, so the drill can link to it (`lib/journalSourceHref`).
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

type Row = DbRow;

/** The document a journal was posted from. */
export type JournalDocumentKind = 'customer_invoice' | 'credit_note' | 'customer_payment' | 'supplier_invoice' | 'supplier_payment';
export interface JournalDocumentRef { kind: JournalDocumentKind; id: string }

interface TransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
  /** Posted rows only (a derived year-end close row has none). */
  journalId?: string;
  /** The document the journal was posted from; null when none (posted rows only). */
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
  dims: { cc1Id?: string; cc2Id?: string } = {},
): Promise<AccountTransactionsReport> {
  assertLedgerRange(periodStart, periodEnd);
  const cc = costCentreId ?? null;
  const bu = businessUnitId ?? null;
  const cc1 = dims.cc1Id ?? null;
  const cc2 = dims.cc2Id ?? null;
  try {
    const acctRows = (await sql`
      SELECT ga.account_name, ga.account_type, ga.normal_balance
      FROM gl_accounts ga
      WHERE ga.account_code = ${accountCode} AND ga.company_id = ${companyId}::UUID LIMIT 1
    `) as Row[];
    if (!acctRows[0]) throw new LedgerAccountNotFoundError(accountCode);

    const normalBal = String(acctRows[0].normal_balance);
    const accountType = String(acctRows[0].account_type);
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
        jl.debit, jl.credit, doc.kind AS doc_kind, doc.id::TEXT AS doc_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        SELECT 'customer_invoice' AS kind, ci.id FROM customer_invoices ci WHERE ci.gl_journal_entry_id = je.id AND ci.company_id = ${companyId}::UUID
        UNION ALL SELECT 'credit_note', cn.id FROM credit_notes cn WHERE cn.gl_journal_entry_id = je.id AND cn.company_id = ${companyId}::UUID
        UNION ALL SELECT 'customer_payment', cp.id FROM customer_payments cp WHERE cp.gl_journal_entry_id = je.id AND cp.company_id = ${companyId}::UUID
        UNION ALL SELECT 'supplier_invoice', si.id FROM supplier_invoices si WHERE si.gl_journal_entry_id = je.id AND si.company_id = ${companyId}::UUID
        UNION ALL SELECT 'supplier_payment', sp.id FROM supplier_payments sp WHERE sp.gl_journal_entry_id = je.id AND sp.company_id = ${companyId}::UUID
        LIMIT 1
      ) doc ON TRUE
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

    const lines: Array<Omit<TransactionRow, 'balance'>> = txnRows.map((r: Row) => ({
      date: fmtDate(r.entry_date),
      entryNumber: String(r.entry_number),
      description: String(r.description || ''),
      debit: Number(r.debit || 0),
      credit: Number(r.credit || 0),
      source: String(r.source || 'manual'),
      journalId: String(r.journal_id),
      document: r.doc_kind == null || r.doc_id == null ? null : { kind: String(r.doc_kind) as JournalDocumentKind, id: String(r.doc_id) },
    }));
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
