/**
 * `cash.balance.v1` — the one implementation of "how much cash does this
 * company have according to its ledger".
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Cash had four answers, and the reason they never agreed is more interesting
 * than "four bugs": two of them were not answering the same question.
 *
 *   · `bankAccountStatusService.balance` and `kpiDashboardService` sum
 *     `bank_transactions.amount` — the STATEMENT balance, i.e. what the bank
 *     says. That is a real and useful figure, and it is not this one.
 *   · `cashFlowDirectService.fetchOpeningCash` had the right basis (posted GL
 *     movement on bank-subtype accounts) but kept it private to one file, so
 *     nothing else could call it and the balance sheet re-derived its own.
 *
 * The gap between the two bases is the assurance finding, not noise: on Velocity
 * Fibre the GL says R3,458,375.43 and the statements say R1,018,633.08.
 * Collapsing them into one figure would destroy the only thing that can detect
 * that. So the ledger basis is `cash.balance.v1` and lives here; the statement
 * basis is `cash.statement.v1` and stays with `getBankAccountsStatus`;
 * `bank_statement_coverage` is what puts them side by side.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not filter `is_active`. That column decides whether an account appears
 * in a dropdown and says nothing about whether it holds money — four inactive
 * production accounts carry R137,317.39 between them, R6,550 of it cash, and
 * `casewareExportService` was out of balance by exactly the amount of one such
 * account. Deactivated accounts carrying a balance are surfaced in
 * `deactivatedWithBalance` so the fact is visible, and they are still IN the
 * total, because they are still on the balance sheet.
 *
 * IT SPANS SUBTYPE `bank` AND `cash`. Petty cash is cash. Nine production
 * accounts carry subtype `cash` — all seeded "Petty Cash" at R0.00 today, so
 * widening this changes no live figure, but a real petty-cash balance would
 * otherwise have been silently absent from "cash".
 *
 * It does not exclude clearing or suspense accounts by NAME. No clearing or
 * suspense SUBTYPE exists in this schema, so the only available discriminator is
 * the account's name — which is the exact mechanism that let two accounts typed
 * `default_expense` overstate gross profit by R562,428. Bank-subtype selection
 * already excludes Interbank Transfer Clearing (it is `other_current_asset`);
 * finding a non-nil clearing account is `chart_of_accounts_health`'s job, and
 * duplicating it here by name-matching would be worse than not doing it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface CashAccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The picker flag. Reported, never used to filter. */
  isActive: boolean;
  /** Posted debit less credit on this account, up to and including `asAt`. */
  glBalance: number;
}

export interface CashBalance {
  /** YYYY-MM-DD the figure is stated at. */
  asAt: string;
  /** Sum of `accounts[].glBalance`. */
  total: number;
  accounts: CashAccountBalance[];
  /**
   * Accounts that are deactivated and still carry a non-nil balance. A subset
   * of `accounts`, not an exclusion from it.
   */
  deactivatedWithBalance: CashAccountBalance[];
  /**
   * MAX(created_at) of the journal entries this figure consumed, ISO-8601, or
   * null when nothing is posted. Never `now()` — that would change on every
   * call and make the figure impossible to re-derive.
   */
  postedThrough: string | null;
}

function toIsoTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  return String(raw);
}

export interface CashBalanceOptions {
  /**
   * Bound `asAt` EXCLUSIVELY (`entry_date < asAt`) instead of inclusively.
   *
   * For an opening balance, which is the closing balance of the day BEFORE the
   * period starts. It is an option rather than the caller subtracting a day
   * because date arithmetic in JS on this UTC+2 server is what put 291 journals
   * in the wrong period (migrations 523/524).
   */
  exclusive?: boolean;
}

export async function getCashBalance(
  companyId: string,
  asAt: string,
  options: CashBalanceOptions = {},
): Promise<CashBalance> {
  const exclusive = options.exclusive === true;
  // LEFT JOINs so an account with no postings still appears at zero: "this
  // account has never moved" and "this account is not in the report" are
  // different facts, and only the first one is true.
  //
  // The join predicates carry company_id because they decide WHICH lines
  // aggregate, and an unscoped one on an outer join lets a foreign row through
  // carrying NULLs into the SUM.
  //
  // The status/date restriction lives in the ON clause and is then handled
  // EXPLICITLY in the CASE, which is the whole lesson of `kpiChartsService`: a
  // predicate in a `LEFT JOIN ... ON` restricts nothing, so a draft or
  // out-of-range line survives with `je.id` NULL. Moving it to the WHERE would
  // fix the arithmetic and reintroduce the opposite defect — an account whose
  // only lines are drafts would vanish from the report entirely, and "has never
  // moved" is not the same fact as "is not in this report".
  const rows = (await sql`
    SELECT ga.id,
           ga.account_code,
           ga.account_name,
           ga.is_active,
           COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit - jl.credit END), 0)::numeric AS gl_balance,
           MAX(je.created_at)                              AS posted_through
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl
             ON jl.gl_account_id = ga.id
            AND jl.company_id    = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je
             ON je.id         = jl.journal_entry_id
            AND je.company_id = ${companyId}::UUID
            AND je.status     = 'posted'
            AND (CASE WHEN ${exclusive}
                      THEN je.entry_date <  ${asAt}::DATE
                      ELSE je.entry_date <= ${asAt}::DATE END)
     WHERE ga.company_id      = ${companyId}::UUID
       AND ga.account_subtype IN ('bank', 'cash')
     GROUP BY ga.id, ga.account_code, ga.account_name, ga.is_active
     ORDER BY ga.account_code
  `) as DbRow[];

  const accounts: CashAccountBalance[] = rows.map((r) => ({
    accountId: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    isActive: r.is_active === true,
    glBalance: Number(r.gl_balance ?? 0),
  }));

  const stamps = rows
    .map((r) => toIsoTimestamp(r.posted_through))
    .filter((s): s is string => s !== null);

  return {
    asAt,
    total: accounts.reduce((sum, a) => sum + a.glBalance, 0),
    accounts,
    deactivatedWithBalance: accounts.filter((a) => !a.isActive && a.glBalance !== 0),
    postedThrough: stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b)),
  };
}
