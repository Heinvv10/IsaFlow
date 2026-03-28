/**
 * Phase 3: Transaction-Level Reporting Service
 * Customer, Supplier, Banking, Account, and Audit Trail reports
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface TransactionRow {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
}

// ── Customer Report ─────────────────────────────────────────────────────────

export interface CustomerReportRow {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

export async function getCustomerReport(_companyId: string, 
  periodStart: string,
  periodEnd: string
): Promise<CustomerReportRow[]> {
  try {
    const rows = (await sql`
      SELECT
        c.id AS client_id,
        c.company_name AS client_name,
        COUNT(DISTINCT ci.id) AS invoice_count,
        COALESCE(SUM(ci.total_amount), 0) AS total_invoiced,
        COALESCE(SUM(ci.amount_paid), 0) AS total_paid
      FROM clients c
      LEFT JOIN customer_invoices ci ON ci.client_id = c.id
        AND ci.invoice_date >= ${periodStart}
        AND ci.invoice_date <= ${periodEnd}
        AND ci.status NOT IN ('draft', 'cancelled')
      GROUP BY c.id, c.company_name
      HAVING COUNT(ci.id) > 0
      ORDER BY COALESCE(SUM(ci.total_amount), 0) DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      clientId: String(r.client_id),
      clientName: String(r.client_name),
      invoiceCount: Number(r.invoice_count),
      totalInvoiced: Number(r.total_invoiced),
      totalPaid: Number(r.total_paid),
      balance: Number(r.total_invoiced) - Number(r.total_paid),
    }));
  } catch (err) {
    log.error('Failed to generate customer report', { error: err }, 'accounting');
    throw err;
  }
}

// ── Supplier Report ─────────────────────────────────────────────────────────

export interface SupplierReportRow {
  supplierId: string;
  supplierName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

export async function getSupplierReport(_companyId: string, 
  periodStart: string,
  periodEnd: string
): Promise<SupplierReportRow[]> {
  try {
    const rows = (await sql`
      SELECT
        s.id AS supplier_id,
        COALESCE(s.company_name, s.name) AS supplier_name,
        COUNT(DISTINCT si.id) AS invoice_count,
        COALESCE(SUM(si.total_amount), 0) AS total_invoiced,
        COALESCE(SUM(si.amount_paid), 0) AS total_paid
      FROM suppliers s
      LEFT JOIN supplier_invoices si ON si.supplier_id = s.id
        AND si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        AND si.status NOT IN ('draft', 'cancelled')
      GROUP BY s.id, s.company_name, s.name
      HAVING COUNT(si.id) > 0
      ORDER BY COALESCE(SUM(si.total_amount), 0) DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name),
      invoiceCount: Number(r.invoice_count),
      totalInvoiced: Number(r.total_invoiced),
      totalPaid: Number(r.total_paid),
      balance: Number(r.total_invoiced) - Number(r.total_paid),
    }));
  } catch (err) {
    log.error('Failed to generate supplier report', { error: err }, 'accounting');
    throw err;
  }
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

export async function getBankTransactions(_companyId: string, 
  periodStart: string,
  periodEnd: string,
  accountCode?: string
): Promise<BankTransactionsReport> {
  try {
    const bankCode = accountCode || '1110';

    // Opening balance (all posted entries before period start)
    const obRows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date < ${periodStart}
        AND ga.account_code = ${bankCode}
    `) as Row[];
    const openingBalance = Number(obRows[0]?.balance || 0);

    // Transactions in period
    const txnRows = (await sql`
      SELECT
        je.entry_date, je.entry_number, je.description, je.source,
        jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND ga.account_code = ${bankCode}
      ORDER BY je.entry_date, je.created_at
    `) as Row[];

    // Get account name
    const acctRows = (await sql`
      SELECT account_name FROM gl_accounts WHERE account_code = ${bankCode} LIMIT 1
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
  _companyId: string,
  accountCode: string,
  periodStart: string,
  periodEnd: string
): Promise<AccountTransactionsReport> {
  try {
    const acctRows = (await sql`
      SELECT account_name, account_type, normal_balance
      FROM gl_accounts WHERE account_code = ${accountCode} LIMIT 1
    `) as Row[];
    if (!acctRows[0]) throw new Error(`Account ${accountCode} not found`);

    const normalBal = String(acctRows[0].normal_balance);

    // Opening balance
    const obRows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date < ${periodStart}
        AND ga.account_code = ${accountCode}
    `) as Row[];

    const obDebit = Number(obRows[0]?.total_debit || 0);
    const obCredit = Number(obRows[0]?.total_credit || 0);
    const openingBalance = normalBal === 'debit' ? obDebit - obCredit : obCredit - obDebit;

    // Transactions
    const txnRows = (await sql`
      SELECT
        je.entry_date, je.entry_number, je.description, je.source,
        jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
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
      const rawDate = r.entry_date instanceof Date
        ? r.entry_date.toISOString().split('T')[0]
        : String(r.entry_date || '').split('T')[0];
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

export async function getAuditTrail(_companyId: string, 
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
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      LEFT JOIN users u ON u.id::TEXT = je.created_by::TEXT
      WHERE je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
      GROUP BY je.id, je.entry_date, je.entry_number, je.description,
        je.source, je.status, u.first_name, u.last_name, je.created_by, je.created_at, je.posted_at
      ORDER BY je.created_at DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      entryDate: r.entry_date instanceof Date
        ? r.entry_date.toISOString().split('T')[0]!
        : String(r.entry_date || '').split('T')[0]!,
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
