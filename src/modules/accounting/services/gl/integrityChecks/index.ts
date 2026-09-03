/**
 * The integrity check runner.
 *
 * Thirteen checks, each a count, a rand total and a bounded sample. Callers ask
 * for all of them or name the ones they want.
 *
 * A CHECK THAT FAILS DOES NOT FAIL THE SUITE. One broken query would otherwise
 * take the other twelve down with it, which on an integrity report is precisely
 * backwards: the reader would lose the twelve answers that worked and be told
 * nothing about the one that did not. A failing check is returned with its
 * error named in `finding` and a count of -1, so it can never be mistaken for
 * a clean result.
 */
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  INTEGRITY_CHECK_IDS,
  type IntegrityCheckContext,
  type IntegrityCheckFn,
  type IntegrityCheckId,
  type IntegrityCheckResult,
} from './types';
import {
  documentsOutsideOpenPeriod,
  invoicesNullDueDate,
  invoicesWithoutRevenueLine,
} from './documentChecks';
import {
  duplicateBankReferences,
  journalDateDiffersFromBankDate,
  staleSuggestedTransactions,
} from './bankChecks';
import {
  assetAccountsWithCreditBalance,
  clearingAccountsNotNil,
  costOfSalesTypedAsExpense,
  deactivatedAccountsWithBalance,
  duplicateControlAccounts,
} from './accountChecks';
import { testRecordsInProduction, vatDisplayedDiffersFromPosted } from './vatChecks';

export const INTEGRITY_CHECKS: Record<IntegrityCheckId, IntegrityCheckFn> = {
  invoices_null_due_date: invoicesNullDueDate,
  vat_displayed_differs_from_posted: vatDisplayedDiffersFromPosted,
  journal_date_differs_from_bank_date: journalDateDiffersFromBankDate,
  duplicate_bank_references: duplicateBankReferences,
  deactivated_accounts_with_balance: deactivatedAccountsWithBalance,
  asset_accounts_with_credit_balance: assetAccountsWithCreditBalance,
  cost_of_sales_typed_as_expense: costOfSalesTypedAsExpense,
  clearing_accounts_not_nil: clearingAccountsNotNil,
  duplicate_control_accounts: duplicateControlAccounts,
  documents_outside_open_period: documentsOutsideOpenPeriod,
  stale_suggested_transactions: staleSuggestedTransactions,
  test_records_in_production: testRecordsInProduction,
  invoices_without_revenue_line: invoicesWithoutRevenueLine,
};

export interface IntegrityReport {
  asAt: string;
  checks: IntegrityCheckResult[];
  /** Failing rows across every check that ran. */
  failingRowsTotal: number;
  /** Checks that found something. */
  checksFailed: number;
  /** Checks whose query itself errored. Never counted as clean. */
  checksErrored: IntegrityCheckId[];
  /** MAX(created_at) of the ledger this report read. */
  postedThrough: string;
}

export interface RunIntegrityChecksOptions {
  checks?: readonly IntegrityCheckId[];
  asAt: string;
  limit?: number;
}

export async function runIntegrityChecks(
  companyId: string,
  options: RunIntegrityChecksOptions,
): Promise<IntegrityReport> {
  const ids = options.checks?.length ? options.checks : INTEGRITY_CHECK_IDS;
  const ctx: IntegrityCheckContext = {
    companyId,
    asAt: options.asAt,
    limit: Math.min(Math.max(options.limit ?? 20, 1), 100),
  };

  const results: IntegrityCheckResult[] = [];
  const errored: IntegrityCheckId[] = [];

  // Sequential on purpose. These are the heaviest reads in the module and they
  // share one request connection: `Promise.all` over a savepoint-free read
  // transaction gains nothing and makes a failure harder to attribute.
  for (const id of ids) {
    const fn = INTEGRITY_CHECKS[id];
    try {
      results.push(await fn(ctx));
    } catch (err) {
      errored.push(id);
      log.error('integrity check failed', { check: id, error: err }, 'integrityChecks');
      results.push({
        id,
        label: id,
        severity: 'high',
        count: -1,
        amount: null,
        sample: [],
        finding: 'This check did not run. Its result is unknown — treat it as unanswered, not as clean.',
      });
    }
  }

  return {
    asAt: options.asAt,
    checks: results,
    failingRowsTotal: results.reduce((s, r) => s + Math.max(r.count, 0), 0),
    checksFailed: results.filter((r) => r.count > 0).length,
    checksErrored: errored,
    postedThrough: await postedThrough(companyId, options.asAt),
  };
}

/**
 * The latest ledger write these checks could have seen. Never `now()` — the
 * same `as_at` with the same `posted_through` must give the same answers.
 */
async function postedThrough(companyId: string, asAt: string): Promise<string> {
  const rows = (await sql`
    SELECT MAX(je.created_at) AS ts
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.entry_date <= ${asAt}::DATE
  `) as DbRow[];
  const ts = rows[0]?.ts;
  if (ts instanceof Date) return ts.toISOString();
  return ts ? String(ts) : `${asAt}T00:00:00.000Z`;
}

export * from './types';
