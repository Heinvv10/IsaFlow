/**
 * The accounts an assumptions document names for income-tax payable and dividends payable (spec §5:
 * "account chosen in assumptions"; no subtype exists for either, §13.10). Their opening balances move into
 * the engine's `incomeTaxPayable` / `dividendsPayable` buckets (`applyPayableAccounts`), so 10b's prior-year
 * top-up fires from a real balance.
 *
 * A named account must be a LEAF liability of the company (the opening read's leaf rule: level >= 3 or no
 * child; a header's balance is never in the opening), and the two must differ; otherwise the document is
 * refused as `AssumptionsDocError` (400 BUDGET_ASSUMPTIONS_INVALID, the path named). Checked when a document
 * is saved and again on every run (an account can be retyped or re-parented later). company_id on every query.
 */
import { sql, type DbRow } from '@/lib/neon';
import type { StoredAssumptionsDoc, ThreeWayAssumptions } from './assumptionsSchema';
import { isFullDoc } from './assumptionsSchema';
import { AssumptionsDocError, type AssumptionsIssue } from './errors';
import type { PayableAccounts } from './threeWayFolds';

export interface LiabilityAccount {
  id: string;
  accountCode: string;
  accountName: string;
}

/** The ids a resolved document names. */
export function payableAccountsOf(a: ThreeWayAssumptions): PayableAccounts {
  return { incomeTaxPayable: a.incomeTax.payableAccountId, dividendsPayable: a.equity.dividendsPayableAccountId };
}

/** The ids a stored document (full, or a scenario's overrides) names, with their document paths. */
export function namedInDoc(doc: StoredAssumptionsDoc): { named: PayableAccounts; paths: { incomeTaxPayable: string; dividendsPayable: string } } {
  if (isFullDoc(doc)) {
    return { named: payableAccountsOf(doc), paths: { incomeTaxPayable: 'incomeTax.payableAccountId', dividendsPayable: 'equity.dividendsPayableAccountId' } };
  }
  return {
    named: { incomeTaxPayable: doc.overrides.incomeTax?.payableAccountId, dividendsPayable: doc.overrides.equity?.dividendsPayableAccountId },
    paths: { incomeTaxPayable: 'overrides.incomeTax.payableAccountId', dividendsPayable: 'overrides.equity.dividendsPayableAccountId' },
  };
}

/** Refuses (AssumptionsDocError) a named account that is not a leaf liability of the company, or one named twice. */
export async function assertPayableAccounts(
  companyId: string, named: PayableAccounts,
  paths: { incomeTaxPayable: string; dividendsPayable: string } = { incomeTaxPayable: 'incomeTax.payableAccountId', dividendsPayable: 'equity.dividendsPayableAccountId' },
): Promise<void> {
  const ids = [named.incomeTaxPayable, named.dividendsPayable].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
  if (ids.length === 0) return;
  const rows = (await sql`
    SELECT ga.id::TEXT AS id, ga.account_type,
           (ga.level >= 3 OR NOT EXISTS (
             SELECT 1 FROM gl_accounts child WHERE child.parent_account_id = ga.id AND child.company_id = ${companyId}::UUID
           )) AS leaf
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const ok = new Set(rows.filter((r) => String(r.account_type) === 'liability' && r.leaf === true).map((r) => String(r.id).toLowerCase()));
  const issues: AssumptionsIssue[] = [];
  for (const key of ['incomeTaxPayable', 'dividendsPayable'] as const) {
    const id = named[key]?.toLowerCase();
    if (id && !ok.has(id)) issues.push({ path: paths[key], message: 'Must be a liability account (not a header) of this company' });
  }
  if (ids.length === 2 && ids[0] === ids[1]) issues.push({ path: paths.dividendsPayable, message: 'Income tax and dividends payable must be different accounts' });
  if (issues.length > 0) throw new AssumptionsDocError(issues);
}

/** Active leaf liability accounts of the company (the derive's candidates). */
export async function readActiveLeafLiabilities(companyId: string): Promise<LiabilityAccount[]> {
  const rows = (await sql`
    SELECT ga.id::TEXT AS id, ga.account_code, ga.account_name
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.account_type = 'liability' AND ga.is_active
       AND (ga.level >= 3 OR NOT EXISTS (
         SELECT 1 FROM gl_accounts child WHERE child.parent_account_id = ga.id AND child.company_id = ${companyId}::UUID
       ))
     ORDER BY ga.account_code
  `) as DbRow[];
  return rows.map((r) => ({ id: String(r.id).toLowerCase(), accountCode: String(r.account_code), accountName: String(r.account_name) }));
}
