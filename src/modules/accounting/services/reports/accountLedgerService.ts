/**
 * Account Ledger Service — paginated GL journal lines for a given account/date range.
 * Identifies account by UUID (accountId) or account_code.
 * Multi-tenant: every query is company_id-scoped on BOTH gl_journal_entries and gl_journal_lines.
 * SQL checklist (re-read before merge):
 *   [x] Account-meta: company_id FIRST   [x] Opening-balance: jl + je scoped
 *   [x] Count: jl + je scoped            [x] Ledger rows: jl + je scoped
 *   [x] Period-totals aggregate: jl + je scoped
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toMoney } from '@/lib/money/decimalSum';
import { DEFAULT_FY_START_MONTH, resolveFiscalYearStartMonth } from '../gl/fiscalYearBasis';
import { fiscalYearStartsWithin, incomeStatementOpeningFloor } from '../gl/fiscalYearCloseRows';
import { assertLedgerRange } from '../gl/ledgerDateRange';
import { LedgerAccountNotFoundError } from '../gl/ledgerErrors';
import { buildPageRows, loadYearEndCloses, netOfFirstLines, planPage, type LedgerScope } from './accountLedgerYearEnd';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

type Row = DbRow;

import type { AccountLedgerMeta, AccountLedgerResult, GetAccountLedgerParams } from './accountLedgerTypes';
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

  assertLedgerRange(fromDate, toDate);
  if (!accountId && !accountCode) {
    throw new Error('Either accountId or accountCode is required');
  }

  try {
    // 1. Resolve account metadata — scoped to company.
    //    company_id is the FIRST condition in every WHERE.
    //    The company's financial_year_start rides along (LEFT JOIN: no extra round-trip).
    const acctRows = accountId
      ? (await sql`
          SELECT ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
                 c.financial_year_start
          FROM gl_accounts ga
          LEFT JOIN companies c ON c.id = ga.company_id
          WHERE ga.company_id = ${companyId}::UUID
            AND ga.id         = ${accountId}::UUID
          LIMIT 1
        `) as Row[]
      : (await sql`
          SELECT ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
                 c.financial_year_start
          FROM gl_accounts ga
          LEFT JOIN companies c ON c.id = ga.company_id
          WHERE ga.company_id   = ${companyId}::UUID
            AND ga.account_code = ${accountCode as string}
          LIMIT 1
        `) as Row[];

    if (!acctRows[0]) {
      const identifier = accountId ?? accountCode;
      throw new LedgerAccountNotFoundError(String(identifier));
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
    //    Income-statement accounts restart each fiscal year (trialBalanceBasis),
    //    so their opening is floored at the start of the fiscal year containing
    //    fromDate — otherwise the drill-down cannot tie to the TB row (LED-01).
    //    READ PATH: the March fallback is taken here, visibly, as the TB does.
    //    company_id is the FIRST condition in both table scopes.
    const fyStartMonth = resolveFiscalYearStartMonth(
      acct.financial_year_start, companyId, { fallback: DEFAULT_FY_START_MONTH },
    );
    const openingFloor = incomeStatementOpeningFloor(meta.accountType, fromDate, fyStartMonth);
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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date    < ${fromDate}
            AND (${openingFloor}::date IS NULL OR je.entry_date >= ${openingFloor}::date)
            AND je.status        = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date    < ${fromDate}
            AND (${openingFloor}::date IS NULL OR je.entry_date >= ${openingFloor}::date)
            AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        `) as Row[];

    const obDebit = Number(obRows[0]?.total_debit ?? 0);
    const obCredit = Number(obRows[0]?.total_credit ?? 0);
    // Debit-normal accounts: balance = debits − credits.
    // Credit-normal accounts: balance = credits − debits.
    const openingBalance = toMoney(
      normalBalance === 'debit' ? obDebit - obCredit : obCredit - obDebit,
    );

    // 3. Count total matching rows in range for pagination.
    const countRows = postedOnly
      ? (await sql`
          SELECT COUNT(*) AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        `) as Row[]
      : (await sql`
          SELECT COUNT(*) AS total
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id    = ${companyId}::UUID
            AND je.company_id    = ${companyId}::UUID
            AND jl.gl_account_id = ${resolvedAccountId}::UUID
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        `) as Row[];

    const lineTotal = Number(countRows[0]?.total ?? 0);

    // 3b. Year-end closes when an income-statement range crosses a fiscal-year
    //     start, and which journal lines this page of (lines + closes) needs.
    const scope: LedgerScope = {
      companyId, accountId: resolvedAccountId, cc, bu, postedOnly, fromDate, toDate, normalBalance,
    };
    const boundaries = openingFloor ? fiscalYearStartsWithin(fromDate, toDate, fyStartMonth) : [];
    const closes = openingFloor && boundaries.length > 0
      ? await loadYearEndCloses(scope, openingFloor, boundaries)
      : [];
    const plan = planPage(closes, offset, limit);

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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          ORDER BY je.entry_date ASC, COALESCE(je.created_at, 'epoch'::timestamptz) ASC, jl.id ASC
          LIMIT  ${plan.lineLimit}
          OFFSET ${plan.lineOffset}
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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
          ORDER BY je.entry_date ASC, COALESCE(je.created_at, 'epoch'::timestamptz) ASC, jl.id ASC
          LIMIT  ${plan.lineLimit}
          OFFSET ${plan.lineOffset}
        `) as Row[];

    // 5. Running balance: a page opens at the balance after every row before it
    //    (lines and closes), not at the period opening balance.
    const pageOpening = toMoney(
      openingBalance
        + (await netOfFirstLines(scope, plan.lineOffset))
        - plan.closesBefore.reduce((sum, c) => sum + c.balanceBefore, 0),
    );
    const rows = buildPageRows(txnRows, closes, { offset, limit }, pageOpening, normalBalance);

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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.status        = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
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
            AND (${cc}::uuid IS NULL OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
            AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
            AND je.entry_date   >= ${fromDate}
            AND je.entry_date   <= ${toDate}
            AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        `) as Row[];

    const periodDebit = Number(periodRows[0]?.period_debit ?? 0);
    const periodCredit = Number(periodRows[0]?.period_credit ?? 0);
    const periodNet = toMoney(
      normalBalance === 'debit' ? periodDebit - periodCredit : periodCredit - periodDebit,
    );
    const closedToRetainedEarnings = toMoney(-closes.reduce((sum, c) => sum + c.balanceBefore, 0));
    const periodClosingBalance = toMoney(openingBalance + periodNet + closedToRetainedEarnings);
    const total = lineTotal + closes.length;

    return { rows, total, derivedRows: closes.length, openingBalance, periodNet, closedToRetainedEarnings, periodClosingBalance, meta };
  } catch (err) {
    // companyId is already tagged on the Bugsink event via setTenantTags — omit here.
    const context = { error: err, accountId, accountCode };
    if (err instanceof LedgerAccountNotFoundError) log.warn('getAccountLedger: account not found', context, 'accounting');
    else log.error('getAccountLedger failed', context, 'accounting');
    throw err;
  }
}
