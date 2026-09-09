/**
 * The one predicate the balance sheet uses to decide whether an account appears
 * at all, and the level constant `accountParentRules` already named for it.
 *
 * `balanceSheetService` and `trendRowsService` both select an account only when
 * `level >= 3 OR it has no children` — a level 1 or 2 account WITH children is
 * a header, and every rand posted on it is silently absent from both reports
 * while the trial balance still foots. Three write paths can put money there:
 * `assertParentUsable` guards the chart edits (create a child, reparent an
 * account), and this file guards the two that were missing it — an account
 * merge that reparents children onto a summary target (K-051) and a
 * reclassification aimed at a header (K-052).
 *
 * Note the SCOPE of the rule. Both readers also filter
 * `account_type IN ('asset','liability','equity')`, and `incomeStatementService`
 * applies no level filter at all — a level-2 expense header with children is on
 * the income statement, balance and all. So a guard that refuses a revenue or
 * expense target is refusing something that loses nothing, which is why
 * `LEAF_RULE_ACCOUNT_TYPES` exists rather than a bare level test.
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
  if (!LEAF_RULE_ACCOUNT_TYPES.has(accountType)) return true;
  if (level >= BALANCE_SHEET_LEAF_LEVEL) return true;
  return !(await hasChildAccounts(companyId, accountId));
}
