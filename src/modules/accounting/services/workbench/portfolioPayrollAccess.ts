/**
 * Who may see the Payroll card of a portfolio row. The portfolio spans every client the user belongs to, and Payroll
 * read is per company (company_users + company_user_permissions), so the active company's answer says nothing about the
 * others. One query decides it for all of them, by `memberMay`, the rule `withPayrollModule` enforces on the payroll
 * routes; a company the user has no membership row in, or one the query does not return, is NOT readable (fail closed).
 *
 * It runs on the BYPASSRLS admin pool, like the row builds: under the request's tenant GUC RLS hides the user's rows in
 * every other company, and the role default would then answer "read" for a company whose row says no. The filter is
 * explicit: this user, these companies (the authorised set getUserCompanies returned).
 */
import type { Pool } from 'pg';
import { memberMay } from '@/lib/auth/permissionService';
import type { PortfolioRow } from './portfolioWorkbenchService';

const PAYROLL_CARD = 'payroll';

/** companyId -> whether `userId` has Payroll read there. Every id asked about is in the map. */
export async function payrollReadByCompany(
  pool: Pick<Pool, 'query'>, userId: string, companyIds: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>(companyIds.map((id) => [id, false]));
  if (companyIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT cu.company_id, cu.role, cu.approve_withheld,
            p.can_read, p.can_write, p.can_delete, p.can_export, p.can_approve, (p.module_key IS NOT NULL) AS has_row
       FROM company_users cu
       LEFT JOIN company_user_permissions p
         ON p.company_id = cu.company_id AND p.user_id = cu.user_id AND p.module_key = $3
      WHERE cu.user_id = $1 AND cu.company_id = ANY($2::uuid[])`,
    [userId, [...companyIds], PAYROLL_CARD],
  );
  for (const r of rows as Array<Record<string, unknown>>) out.set(String(r.company_id), memberMay(r, 'read', PAYROLL_CARD));
  return out;
}

/**
 * The row as a user without Payroll read there may see it: no payroll card, and the counts and the clients-at-risk
 * judgement made from the cards that remain. `payrollHidden` tells the page to say so instead of showing an empty cell.
 */
export function withoutPayrollCard(row: PortfolioRow): PortfolioRow {
  const cards = row.cards.filter((c) => c.id !== PAYROLL_CARD);
  return {
    ...row,
    cards,
    readyCount: cards.filter((c) => c.status === 'ready').length,
    attentionCount: cards.filter((c) => c.status === 'attention').length,
    blockedCount: cards.filter((c) => c.status === 'blocked').length,
    payrollHidden: true,
  };
}
