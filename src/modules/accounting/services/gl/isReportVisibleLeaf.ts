/**
 * The one predicate the balance sheet uses to decide whether an account appears
 * at all, and the level constant `accountParentRules` already named for it.
 *
 * `balanceSheetService` and `trendRowsService` both select an account only when
 * `level >= 3 OR it has no children` — a level 1 or 2 account WITH children is
 * a header, and every rand posted on it is silently absent from both reports
 * while the trial balance still foots. Three CHART edits can put existing money
 * there: `assertParentUsable` guards create-a-child and reparent, and this file
 * guards the two that were missing it — an account merge that reparents
 * children onto a summary target (K-051) and a reclassification aimed at a
 * header (K-052). New journal lines are refused by `headerAccountGuard` (below).
 *
 * Note the SCOPE of the rule. Both readers also filter
 * `account_type IN ('asset','liability','equity')`, and `incomeStatementService`
 * applies no level filter at all — a level-2 expense header with children is on
 * the income statement, balance and all. So a guard that refuses a revenue or
 * expense target is refusing something that loses nothing, which is why
 * `LEAF_RULE_ACCOUNT_TYPES` exists rather than a bare level test.
 *
 * `validateLeafAccount` is deliberately STRICTER than this file where it runs —
 * it refuses posting to any parent account, of any type and any level
 * (migration 484). The two are not in conflict: a direct post is a choice the
 * user makes line by line and "pick a leaf account" is cheap advice at that
 * moment, whereas these three chart guards decide whether a bulk move of existing
 * lines may proceed at all, and refusing one costs the accountant a chart tidy
 * that loses nothing. Where the reports cannot lose the money, these admit it.
 *
 * Ordinary posting is guarded separately, by the same predicate:
 * `headerAccountGuard.assertNoHeaderAccountLines` (D1, 2026-10-12) refuses a
 * NEW journal line on a header in every writer of `gl_journal_lines`
 * (`journalLineWriterCensus.test.ts`). There is still no trigger, and the
 * guard exempts contra legs (reversals, a reclassification's source), so lines
 * already on a header stay where they are until someone moves them.
 */
import { sql } from '@/lib/neon';

/**
 * The level at and below which the two reports include an account regardless of
 * its children. Above it, gaining a child removes the account from them.
 */
export const BALANCE_SHEET_LEAF_LEVEL = 3;

/** The account types whose reports carry the leaf rule. */
export const LEAF_RULE_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'asset', 'liability', 'equity',
]);

/**
 * Whether the leaf rule applies to this account at all — the ONE statement of
 * it, called by `isReportVisibleLeaf` below, by `accountMergeGuards` (which
 * needs the source and target arms apart and so cannot use the predicate
 * whole) and by `planGuards` (which must take a row lock before asking).
 */
export function isSubjectToLeafRule(level: number, accountType: string): boolean {
  return LEAF_RULE_ACCOUNT_TYPES.has(accountType) && level < BALANCE_SHEET_LEAF_LEVEL;
}

/** True when any account in the company names `accountId` as its parent. */
export async function hasChildAccounts(companyId: string, accountId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_accounts
     WHERE parent_account_id = ${accountId}::UUID
       AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Whether the balance sheet and the trend report can reach this account today.
 *
 * An account whose type those reports never select is visible by definition:
 * it is read by the income statement, which has no level filter. Otherwise
 * `level >= 3` short-circuits without a query, and a level 1 or 2 account is
 * visible only while it is childless — which is why Sage-imported charts, whose
 * leaves sit at level 1, keep working.
 */
export async function isReportVisibleLeaf(
  companyId: string, accountId: string, level: number, accountType: string,
): Promise<boolean> {
  if (!isSubjectToLeafRule(level, accountType)) return true;
  return !(await hasChildAccounts(companyId, accountId));
}
