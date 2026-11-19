/**
 * The garnishee payable (wave 6 GA, spec F13): the liability a run's garnishee deductions are credited to until the
 * employer pays the creditor (paying the creditor is out of scope this wave).
 *
 * Created LAZILY, on a company's first garnishee order, never seeded: a company without garnishees gets no account,
 * no chart change, no definer and no 930 row. It is a `payroll_liability` system account (the subtype every report,
 * control-account rule and cash-flow band already treats as a payroll liability), named "Garnishee Orders Payable",
 * under the same parent as 2140 PAYE.
 *
 * Its identity is the orders, not a code or a name: every order records the account it credits
 * (payroll_garnishee_orders.payable_account_id), and a later order of the company takes the account its earlier orders
 * name, whatever it has since been renamed or renumbered to. It is not a SYSTEM_ACCOUNT_KEYS role: a role there is
 * reported missing on every company that lacks it (chart_of_accounts_health), which F13 rules out.
 *
 * Lock order: the company's role-write advisory lock (lockSystemRoleWrites, the lock every chart writer takes first)
 * is taken BEFORE the read that decides whether to create, and is held to the end of the request's transaction, in
 * which the caller then inserts the order. Two first orders of a company therefore serialise: the second reads the
 * first's order (committed by then) and reuses its account.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { clearSystemAccountCacheAfterCommit } from '../gl/systemAccountResolver';
import { boundedRowWait, lockSystemRoleWrites } from '../gl/systemRoleWriteLock';
import { assertRolesKept, snapshotRoles } from '../gl/systemRoleInvariant';
import { roleBarringChildren } from '../gl/roleTargetRules';
import { GarnisheeOrderRefusal } from './payrollGarnishee';

export const GARNISHEE_PAYABLE_NAME = 'Garnishee Orders Payable';
const PREFERRED_CODES = ['2180', '2181', '2182', '2183', '2184', '2185', '2186', '2187', '2188', '2189'] as const;
/** The parent is 2140 PAYE's: the chart's payroll liabilities group (or none). */
const PAYE_CODE = '2140';

/** The account the company's orders credit, if it has any order. Read under the lock by ensureGarnisheePayable. */
export async function existingGarnisheePayable(companyId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT payable_account_id::text AS id FROM payroll_garnishee_orders
     WHERE company_id = ${companyId}::uuid ORDER BY created_at, id LIMIT 1
  `) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * The company's garnishee payable account id, created on the first call. Must run inside the request's transaction,
 * with the order insert after it in the same transaction (the advisory lock is transaction-scoped).
 */
export async function ensureGarnisheePayable(companyId: string): Promise<{ id: string; created: boolean }> {
  await lockSystemRoleWrites(companyId);
  const existing = await existingGarnisheePayable(companyId);
  if (existing) return { id: existing, created: false };

  const taken = new Set(((await sql`
    SELECT account_code FROM gl_accounts WHERE company_id = ${companyId}::uuid AND account_code = ANY(${[...PREFERRED_CODES]}::text[])
  `) as DbRow[]).map((r) => String(r.account_code)));
  const code = PREFERRED_CODES.find((c) => !taken.has(c));
  if (!code) {
    throw new GarnisheeOrderRefusal(409, 'NO_FREE_ACCOUNT_CODE',
      `No free account code among ${PREFERRED_CODES[0]}-${PREFERRED_CODES[PREFERRED_CODES.length - 1]} for ${GARNISHEE_PAYABLE_NAME}. `
      + 'Free one of those codes in the chart of accounts, then enter the order again.');
  }
  const parents = (await sql`
    SELECT p.id, p.level, p.account_type, p.account_subtype, p.is_system_account
      FROM gl_accounts a JOIN gl_accounts p ON p.id = a.parent_account_id AND p.company_id = a.company_id
     WHERE a.company_id = ${companyId}::uuid AND a.account_code = ${PAYE_CODE} AND p.account_type = 'liability'
     LIMIT 1
  `) as DbRow[];
  // PAYE's parent already has a child (PAYE), so it is a header already: no balance is hidden by adding another.
  // A parent that holds a role cannot take children (roleTargetRules): the account then goes at the top level.
  const parent = parents[0] && !roleBarringChildren(parents[0]) ? parents[0] : undefined;
  const roles = await snapshotRoles(companyId);
  const rows = (await boundedRowWait(() => sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, level, display_order, is_system_account, parent_account_id, is_active, description
    ) VALUES (
      ${companyId}::uuid, ${code}, ${GARNISHEE_PAYABLE_NAME}, 'liability', 'payroll_liability',
      'credit', ${parent ? Number(parent.level ?? 0) + 1 : 1}, 218, true, ${parent ? String(parent.id) : null}::uuid, true,
      'Garnishee (court order) deductions from pay, owed to the creditors named on the orders until paid over.'
    )
    RETURNING id
  `)) as DbRow[];
  await assertRolesKept(companyId, roles);
  clearSystemAccountCacheAfterCommit(companyId);
  log.info('Created the garnishee payable account', { companyId, code }, 'payrollGarnishee');
  return { id: String(rows[0]!.id), created: true };
}
