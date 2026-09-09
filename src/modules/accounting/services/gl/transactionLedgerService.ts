/**
 * Transaction Ledger Service
 * Bank transactions, account transactions, and audit trail reports.
 * Customer and supplier reports live in transactionReportingService.ts.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from './systemAccountResolver';

type Row = DbRow;

interface TransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
}

// ── Bank Transactions ───────────────────────────────────────────────────────

export interface BankTransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  deposit: number;
  withdrawal: number;
  runningBalance: number;
}

export interface BankTransactionsReport {
  accountCode: string;
  accountName: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  transactions: BankTransactionRow[];
}

export async function getBankTransactions(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  accountCode?: string
): Promise<BankTransactionsReport> {
  try {
    const bankCode = accountCode || (await getSystemAccount('bank', companyId)).accountCode;

    const obRows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date < ${periodStart}
        AND ga.account_code = ${bankCode}
    `) as Row[];
    const openingBalance = Number(obRows[0]?.balance || 0);

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
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_code = ${bankCode}
      ORDER BY je.entry_date, je.created_at
    `) as Row[];

    const acctRows = (await sql`
      SELECT account_name FROM gl_accounts
      WHERE account_code = ${bankCode} AND company_id = ${companyId}::UUID
      LIMIT 1
    `) as Row[];

    let running = openingBalance;
    const transactions: BankTransactionRow[] = txnRows.map((r: Row) => {
      const dep = Number(r.debit || 0);
      const wd = Number(r.credit || 0);
      running += dep - wd;
      return {
        date: String(r.entry_date).split('T')[0] ?? '',
        entryNumber: String(r.entry_number),
        description: String(r.description || ''),
        deposit: dep,
        withdrawal: wd,
        runningBalance: running,
      };
    });

    return {
      accountCode: bankCode,
      accountName: String(acctRows[0]?.account_name || 'Bank'),
      periodStart,
      periodEnd,
      openingBalance,
      closingBalance: running,
      transactions,
    };
  } catch (err) {
    log.error('Failed to generate bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Account Transactions ────────────────────────────────────────────────────

export interface AccountTransactionsReport {
  accountCode: string;
  accountName: string;
  accountType: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  transactions: TransactionRow[];
}

export async function getAccountTransactions(
  companyId: string,
  accountCode: string,
  periodStart: string,
  periodEnd: string,
  costCentreId?: string
): Promise<AccountTransactionsReport> {
  const cc = costCentreId ?? null;
  try {
    const acctRows = (await sql`
      SELECT account_name, account_type, normal_balance
      FROM gl_accounts WHERE account_code = ${accountCode} AND company_id = ${companyId}::UUID LIMIT 1
    `) as Row[];
    if (!acctRows[0]) throw new Error(`Account ${accountCode} not found`);

    const normalBal = String(acctRows[0].normal_balance);

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
        AND je.entry_date < ${periodStart}
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
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_code = ${accountCode}
      ORDER BY je.entry_date, je.created_at
    `) as Row[];

    let running = openingBalance;
    const transactions: TransactionRow[] = txnRows.map((r: Row) => {
      const d = Number(r.debit || 0);
      const c = Number(r.credit || 0);
      running += normalBal === 'debit' ? d - c : c - d;
      const rawDate = fmtDate(r.entry_date);
      return {
        date: rawDate,
        entryNumber: String(r.entry_number),
        description: String(r.description || ''),
        debit: d,
        credit: c,
        balance: running,
        source: String(r.source || 'manual'),
      };
    });

    return {
      accountCode,
      accountName: String(acctRows[0].account_name),
      accountType: String(acctRows[0].account_type),
      periodStart,
      periodEnd,
      openingBalance,
      closingBalance: running,
      transactions,
    };
  } catch (err) {
    log.error('Failed to generate account transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Audit Trail ─────────────────────────────────────────────────────────────
//
// This is the PERIOD EXPORT view: every entry in a date range, unbounded, with
// both debit and credit totals, consumed by reports-audit-trail.ts and
// audit-trail-export.ts.
//
// It is NOT the attribution view. `gl/auditTrailLedgerService#queryAuditTrail`
// answers "who posted this, and is that recorded or inferred" — paginated,
// actor-filtered, and carrying provenance per row. The two are kept apart
// deliberately: this one must stay unbounded and must keep returning credit
// totals, and folding either shape into the other would change an existing
// signed export. Neither re-derives the other's figures.

export interface AuditTrailRow {
  entryDate: string;
  entryNumber: string;
  description: string;
  source: string;
  status: string;
  totalDebit: number;
  totalCredit: number;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
}

export async function getAuditTrail(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<AuditTrailRow[]> {
  try {
    const rows = (await sql`
      SELECT
        je.entry_date, je.entry_number, je.description, je.source, je.status,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        COALESCE(CONCAT_WS(' ', u.first_name, u.last_name), je.created_by::TEXT) AS created_by_name,
        je.created_at, je.posted_at
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
      LEFT JOIN users u ON u.id::TEXT = je.created_by::TEXT
      WHERE je.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
      GROUP BY je.id, je.entry_date, je.entry_number, je.description,
        je.source, je.status, u.first_name, u.last_name, je.created_by, je.created_at, je.posted_at
      ORDER BY je.created_at DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      entryDate: fmtDate(r.entry_date),
      entryNumber: String(r.entry_number),
      description: String(r.description || ''),
      source: String(r.source || 'manual'),
      status: String(r.status),
      totalDebit: Number(r.total_debit || 0),
      totalCredit: Number(r.total_credit || 0),
      createdBy: String(r.created_by_name || '—'),
      createdAt: String(r.created_at),
      postedAt: r.posted_at ? String(r.posted_at) : null,
    }));
  } catch (err) {
    log.error('Failed to generate audit trail', { error: err }, 'accounting');
    throw err;
  }
}
