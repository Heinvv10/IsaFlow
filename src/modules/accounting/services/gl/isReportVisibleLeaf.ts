/**
 * The one predicate the financial statements use to decide whether an account
 * appears at all.
 *
 * `balanceSheetService` and `trendRowsService` both select an account only when
 * `level >= 3 OR it has no children` — a level 1 or 2 account WITH children is
 * a header, and every rand posted on it is silently absent from the balance
 * sheet and the trend report while the trial balance still foots. Two write
 * paths could put money there: an account merge that reparents children onto a
 * summary target (K-051) and a reclassification aimed at a header (K-052).
 * Both ask this file rather than each carrying its own copy of the predicate,
 * because a second copy is a second thing to forget when the reports change.
 */
import { sql } from '@/lib/neon';

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
 * Whether the reports can reach this account today.
 *
 * `level >= 3` short-circuits without a query: the reports accept those
 * regardless of children. A level 1 or 2 account is visible only while it is
 * childless — which is why Sage-imported charts, whose leaves sit at level 1,
 * keep working.
 */
export async function isReportVisibleLeaf(
  companyId: string, accountId: string, level: number,
): Promise<boolean> {
  if (level >= 3) return true;
  return !(await hasChildAccounts(companyId, accountId));
}
