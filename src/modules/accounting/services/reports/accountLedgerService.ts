/**
 * Account Ledger Service — paginated GL journal lines for a given account/date range.
 * Identifies account by UUID (accountId) or account_code.
 * Multi-tenant: every query is company_id-scoped on BOTH gl_journal_entries and gl_journal_lines.
 * SQL checklist (re-read before merge):
 *   [x] Account-meta: company_id FIRST   [x] Opening-balance: jl + je scoped
 *   [x] Count: jl + je scoped            [x] Ledger rows: jl + je scoped
 *   [x] Period-totals aggregate: jl + je scoped
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

import type { AccountLedgerRow, AccountLedgerMeta, AccountLedgerResult, GetAccountLedgerParams } from './accountLedgerTypes';
export type { AccountLedgerRow, AccountLedgerMeta, AccountLedgerResult, GetAccountLedgerParams } from './accountLedgerTypes';

// WORKING: All WHERE clauses include company_id on both je and jl tables.
export async function getAccountLedger(
  params: GetAccountLedgerParams,
): Promise<AccountLedgerResult> {
  const {
    companyId,
    accountId,
    accountCode,
    costCentreId,
    businessUnitId,
    fromDate,
    toDate,
    postedOnly = true,
    limit = 200,
    offset = 0,
  } = params;

  const cc = costCentreId ?? null;
  const bu = businessUnitId ?? null;

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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
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
        entryDate: fmtDate(r.entry_date),
        entryNumber: String(r.entry_number ?? ''),
        description: String(r.description ?? ''),
        reference: String(r.reference ?? ''),
        source: String(r.source ?? 'manual'),
        debit: d,
        credit: c,
        runningBalance: running,
      };
    });

    // 6. Period totals aggregate — full date range, company_id scoped on BOTH tables.
    //    One extra round-trip; acceptable for a drill-down page.
    //    Returns the true closing balance regardless of pagination.
    const periodRows = postedOnly
      ? (await sql`
          SELECT
            COALESCE(SUM(jl.debit), 0)  AS period_debit,
            COALESCE(SUM(jl.credit), 0) AS period_credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted'
        `) as Row[]
      : (await sql`
          SELECT
            COALESCE(SUM(jl.debit), 0)  AS period_debit,
            COALESCE(SUM(jl.credit), 0) AS period_credit
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
              OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
        `) as Row[];

    const periodDebit = Number(periodRows[0]?.period_debit ?? 0);
    const periodCredit = Number(periodRows[0]?.period_credit ?? 0);
    const periodNet =
      normalBalance === 'debit' ? periodDebit - periodCredit : periodCredit - periodDebit;
    const periodClosingBalance = openingBalance + periodNet;

    return { rows, total, openingBalance, periodNet, periodClosingBalance, meta };
  } catch (err) {
    // companyId is already tagged on the Bugsink event via setTenantTags — omit here.
    log.error(
      'getAccountLedger failed',
      { error: err, accountId, accountCode },
      'accounting',
    );
    throw err;
  }
}
