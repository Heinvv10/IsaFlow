/**
 * Account Ledger Service
 * Returns paginated GL journal lines for a given account in a date range,
 * together with an opening balance and running balance column.
 *
 * The account can be identified by:
 *   - UUID (accountId param)  — preferred when caller has the GL account pk
 *   - account_code (accountCode param) — used when caller only has the code
 *     (e.g. Trial Balance and Balance Sheet rows)
 *
 * Multi-tenant: EVERY query is scoped by company_id on BOTH gl_journal_entries
 * and gl_journal_lines. This is a financial report — a cross-tenant leak here
 * means another company sees your books.
 *
 * SQL security review checklist (re-read before every merge):
 *   [x] Account-meta query:        ga.company_id = ${companyId} is FIRST condition
 *   [x] Opening-balance query:     jl.company_id AND je.company_id both present
 *   [x] Count query:               jl.company_id AND je.company_id both present
 *   [x] Ledger query:              jl.company_id AND je.company_id both present
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface AccountLedgerRow {
  journalEntryId: string;
  entryDate: string;
  entryNumber: string;
  description: string;
  reference: string;
  source: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface AccountLedgerMeta {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
}

export interface AccountLedgerResult {
  rows: AccountLedgerRow[];
  total: number;
  openingBalance: number;
  meta: AccountLedgerMeta;
}

export interface GetAccountLedgerParams {
  companyId: string;
  /** UUID of the GL account. Either accountId or accountCode is required. */
  accountId?: string;
  /** Account code (e.g. "1110"). Either accountId or accountCode is required. */
  accountCode?: string;
  fromDate: string;
  toDate: string;
  /** Default: true — only include posted entries */
  postedOnly?: boolean;
  /** Default: 200 */
  limit?: number;
  /** Default: 0 */
  offset?: number;
}

function toDateString(val: unknown): string {
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? '';
  return String(val ?? '').split('T')[0] ?? '';
}

// WORKING: All WHERE clauses include company_id on both je and jl tables.
export async function getAccountLedger(
  params: GetAccountLedgerParams,
): Promise<AccountLedgerResult> {
  const {
    companyId,
    accountId,
    accountCode,
    fromDate,
    toDate,
    postedOnly = true,
    limit = 200,
    offset = 0,
  } = params;

  if (!accountId && !accountCode) {
    throw new Error('Either accountId or accountCode is required');
  }

  try {
    // 1. Resolve account metadata — scoped to company.
    //    company_id is the FIRST condition in every WHERE.
    const acctRows = accountId
      ? (await sql`
          SELECT id, account_code, account_name, account_type, normal_balance
          FROM gl_accounts
          WHERE company_id = ${companyId}::UUID
            AND id         = ${accountId}::UUID
          LIMIT 1
        `) as Row[]
      : (await sql`
          SELECT id, account_code, account_name, account_type, normal_balance
          FROM gl_accounts
          WHERE company_id   = ${companyId}::UUID
            AND account_code = ${accountCode as string}
          LIMIT 1
        `) as Row[];

    if (!acctRows[0]) {
      const identifier = accountId ?? accountCode;
      throw new Error(`Account ${identifier} not found for this company`);
    }

    const acct = acctRows[0] as Row;
    const resolvedAccountId = String(acct.id);
    const normalBalance = String(acct.normal_balance);
    const meta: AccountLedgerMeta = {
      accountId: resolvedAccountId,
      accountCode: String(acct.account_code),
      accountName: String(acct.account_name),
      accountType: String(acct.account_type),
      normalBalance,
    };

    // 2. Opening balance: sum of all movements BEFORE fromDate.
    //    company_id is the FIRST condition in both table scopes.
    const obRows = postedOnly
      ? (await sql`
          SELECT
            COALESCE(SUM(jl.debit), 0)  AS total_debit,
            COALESCE(SUM(jl.credit), 0) AS total_credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date    < ${fromDate}
            AND je.status        = 'posted'
        `) as Row[]
      : (await sql`
          SELECT
            COALESCE(SUM(jl.debit), 0)  AS total_debit,
            COALESCE(SUM(jl.credit), 0) AS total_credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date    < ${fromDate}
        `) as Row[];

    const obDebit = Number(obRows[0]?.total_debit ?? 0);
    const obCredit = Number(obRows[0]?.total_credit ?? 0);
    // Debit-normal accounts: balance = debits − credits.
    // Credit-normal accounts: balance = credits − debits.
    const openingBalance =
      normalBalance === 'debit' ? obDebit - obCredit : obCredit - obDebit;

    // 3. Count total matching rows in range for pagination.
    const countRows = postedOnly
      ? (await sql`
          SELECT COUNT(*) AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted'
        `) as Row[]
      : (await sql`
          SELECT COUNT(*) AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
        `) as Row[];

    const total = Number(countRows[0]?.total ?? 0);

    // 4. Paginated journal lines — ordered by date then entry id.
    const txnRows = postedOnly
      ? (await sql`
          SELECT
            je.id                         AS journal_entry_id,
            je.entry_date,
            je.entry_number,
            je.description,
            COALESCE(je.reference, '')    AS reference,
            COALESCE(je.source, 'manual') AS source,
            jl.debit,
            jl.credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted'
          ORDER BY je.entry_date ASC, je.id ASC
          LIMIT  ${limit}
          OFFSET ${offset}
        `) as Row[]
      : (await sql`
          SELECT
            je.id                         AS journal_entry_id,
            je.entry_date,
            je.entry_number,
            je.description,
            COALESCE(je.reference, '')    AS reference,
            COALESCE(je.source, 'manual') AS source,
            jl.debit,
            jl.credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
          ORDER BY je.entry_date ASC, je.id ASC
          LIMIT  ${limit}
          OFFSET ${offset}
        `) as Row[];

    // 5. Compute running balance across the paginated slice.
    let running = openingBalance;
    const rows: AccountLedgerRow[] = txnRows.map((r: Row) => {
      const d = Number(r.debit ?? 0);
      const c = Number(r.credit ?? 0);
      running += normalBalance === 'debit' ? d - c : c - d;
      return {
        journalEntryId: String(r.journal_entry_id),
        entryDate: toDateString(r.entry_date),
        entryNumber: String(r.entry_number ?? ''),
        description: String(r.description ?? ''),
        reference: String(r.reference ?? ''),
        source: String(r.source ?? 'manual'),
        debit: d,
        credit: c,
        runningBalance: running,
      };
    });

    return { rows, total, openingBalance, meta };
  } catch (err) {
    log.error(
      'getAccountLedger failed',
      { error: err, accountId, accountCode, companyId },
      'accounting',
    );
    throw err;
  }
}
