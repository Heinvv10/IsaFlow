/**
 * Cost-centre → GL expense-account mapping (mig 458).
 *
 * Consumed by postPayrollRunJournal to split the labour debit across
 * per-centre accounts. Unmapped centres fall back to the default 5200
 * Labour Costs account so the journal is always balanced.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface CostCentreGlMapping {
  id: string;
  costCentreId: string;
  costCentreCode: string;
  costCentreName: string;
  expenseAccountId: string;
  accountCode: string;
  accountName: string;
}

async function assertCostCentreInCompany(companyId: string, costCentreId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM cost_centres
     WHERE id = ${costCentreId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new Error(`Cost centre ${costCentreId} not in company`);
}

/**
 * The account must be the company's and an EXPENSE account: the plan debits it with the centre's labour. A liability
 * here (2170 Net Salaries Payable, say) put labour on the account net pay is credited to, and the journal debited and
 * credited the same account (review round 2). The plan separately blocks a net-pay account shared with any other line
 * (`net_pay_account_shared`), for mappings stored before this check.
 */
async function assertExpenseAccountInCompany(companyId: string, accountId: string): Promise<void> {
  const rows = (await sql`
    SELECT id, account_code, account_type FROM gl_accounts
     WHERE id = ${accountId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new Error(`GL account ${accountId} not in company`);
  if (rows[0]!.account_type !== 'expense') {
    throw new Error(`Account ${String(rows[0]!.account_code)} is a ${String(rows[0]!.account_type)} account: a cost centre's labour can only be mapped to an expense account`);
  }
}

export async function listCostCentreGlMappings(
  companyId: string,
): Promise<CostCentreGlMapping[]> {
  const rows = (await sql`
    SELECT m.id,
           m.cost_centre_id,
           cc.code AS cost_centre_code,
           cc.name AS cost_centre_name,
           m.expense_account_id,
           ga.account_code,
           ga.account_name
      FROM cost_centre_gl_mappings m
      JOIN cost_centres cc ON cc.id = m.cost_centre_id
      JOIN gl_accounts ga ON ga.id = m.expense_account_id
     WHERE m.company_id = ${companyId}::uuid
     ORDER BY cc.code
  `) as DbRow[];
  return rows.map(r => ({
    id: String(r.id),
    costCentreId: String(r.cost_centre_id),
    costCentreCode: String(r.cost_centre_code),
    costCentreName: String(r.cost_centre_name),
    expenseAccountId: String(r.expense_account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
  }));
}

export async function upsertCostCentreGlMapping(
  companyId: string,
  costCentreId: string,
  expenseAccountId: string,
  userId: string,
): Promise<void> {
  await assertCostCentreInCompany(companyId, costCentreId);
  await assertExpenseAccountInCompany(companyId, expenseAccountId);
  log.info(
    'Upserting cost-centre GL mapping',
    { companyId, costCentreId, expenseAccountId },
    'costCentreGlMappingService',
  );
  await sql`
    INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id, created_by)
    VALUES (${companyId}::uuid, ${costCentreId}::uuid, ${expenseAccountId}::uuid, ${userId})
    ON CONFLICT (company_id, cost_centre_id) DO UPDATE
       SET expense_account_id = EXCLUDED.expense_account_id,
           updated_at = NOW()
  `;
}

export async function deleteCostCentreGlMapping(
  companyId: string,
  costCentreId: string,
): Promise<void> {
  await sql`
    DELETE FROM cost_centre_gl_mappings
     WHERE company_id = ${companyId}::uuid
       AND cost_centre_id = ${costCentreId}::uuid
  `;
}

/** Loaded at journal-posting time — returns { costCentreId: expenseAccountId } */
export async function getMappingLookup(companyId: string): Promise<Record<string, string>> {
  const rows = (await sql`
    SELECT cost_centre_id, expense_account_id
      FROM cost_centre_gl_mappings
     WHERE company_id = ${companyId}::uuid
  `) as DbRow[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[String(r.cost_centre_id)] = String(r.expense_account_id);
  }
  return out;
}
