/**
 * The accounts an assumptions document names for income-tax payable and dividends payable (spec §5:
 * "account chosen in assumptions"; no subtype exists for either, §13.10). Their opening balances move into
 * the engine's `incomeTaxPayable` / `dividendsPayable` buckets (`applyPayableAccounts`), so 10b's prior-year
 * top-up fires from a real balance.
 *
 * A named account must be a LEAF liability of the company (the opening read's leaf rule: level >= 3 or no
 * child; a header's balance is never in the opening) whose balance would otherwise sit in other liabilities
 * and which is no loan's account (`payableSlotAllowed`: never AP, VAT, payroll, a loan or a credit card),
 * and the two must differ; otherwise the document is
 * refused as `AssumptionsDocError` (400 BUDGET_ASSUMPTIONS_INVALID, the path named). Checked when a document
 * is saved and again on every run (an account can be retyped or re-parented later). company_id on every query.
 */
import { sql, type DbRow } from '@/lib/neon';
import type { StoredAssumptionsDoc, ThreeWayAssumptions } from './assumptionsSchema';
import { payableSlotAllowed } from './bucketMap';
import { readLoanAccountIds } from './openingBalances';
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

export interface PayableAccountConflict {
  code: 'payable_account_conflict';
  accountId: string;
  kept: 'incomeTaxPayable';
  ignored: 'dividendsPayable';
}

/**
 * A RUN's rule for one account in both slots (a base edited after its scenario was saved): income tax
 * keeps it, the dividends slot is ignored, and the conflict is warned. Pure; never mutates `named`.
 */
export function resolvePayableConflict(named: PayableAccounts): { named: PayableAccounts; warnings: PayableAccountConflict[] } {
  const tax = named.incomeTaxPayable?.toLowerCase();
  if (tax === undefined || tax !== named.dividendsPayable?.toLowerCase()) return { named: { ...named }, warnings: [] };
  return {
    named: { incomeTaxPayable: named.incomeTaxPayable },
    warnings: [{ code: 'payable_account_conflict', accountId: tax, kept: 'incomeTaxPayable', ignored: 'dividendsPayable' }],
  };
}

/** The issue message for one account in both slots; `own` = what the document being saved sets itself. */
function conflictMessage(own: PayableAccounts | undefined): string {
  if (own?.incomeTaxPayable && !own.dividendsPayable) return "Account already used by the base version's dividends payable";
  if (own?.dividendsPayable && !own.incomeTaxPayable) return "Account already used by the base version's income-tax payable";
  if (own && !own.incomeTaxPayable && !own.dividendsPayable) return 'Income tax and dividends payable must be different accounts (both named by the base version)';
  return 'Income tax and dividends payable must be different accounts';
}

/**
 * Refuses (AssumptionsDocError) a named account that is not a leaf liability of the company, or one named twice.
 * `own` (a scenario save checking its resolved chain): the ids the saved override sets itself, so a clash with
 * an id the base supplies says so.
 */
export async function assertPayableAccounts(
  companyId: string, named: PayableAccounts,
  paths: { incomeTaxPayable: string; dividendsPayable: string } = { incomeTaxPayable: 'incomeTax.payableAccountId', dividendsPayable: 'equity.dividendsPayableAccountId' },
  own?: PayableAccounts,
): Promise<void> {
  const ids = [named.incomeTaxPayable, named.dividendsPayable].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
  if (ids.length === 0) return;
  const rows = (await sql`
    SELECT ga.id::TEXT AS id, ga.account_type, ga.account_subtype,
           (ga.level >= 3 OR NOT EXISTS (
             SELECT 1 FROM gl_accounts child WHERE child.parent_account_id = ga.id AND child.company_id = ${companyId}::UUID
           )) AS leaf
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const loans = await readLoanAccountIds(companyId);
  const ok = new Set(rows
    .filter((r) => String(r.account_type) === 'liability' && r.leaf === true
      && payableSlotAllowed(r.account_subtype == null ? null : String(r.account_subtype), loans.has(String(r.id).toLowerCase())))
    .map((r) => String(r.id).toLowerCase()));
  const issues: AssumptionsIssue[] = [];
  for (const key of ['incomeTaxPayable', 'dividendsPayable'] as const) {
    const id = named[key]?.toLowerCase();
    if (id && !ok.has(id)) {
      issues.push({ path: paths[key], message: 'Must be a liability account of this company that is not a header, AP, VAT, payroll, loan or credit-card account' });
    }
  }
  if (ids.length === 2 && ids[0] === ids[1]) issues.push({ path: paths.dividendsPayable, message: conflictMessage(own) });
  if (issues.length > 0) throw new AssumptionsDocError(issues);
}

/** Active leaf liability accounts of the company that may be named (`payableSlotAllowed`): the derive's candidates. */
export async function readActiveLeafLiabilities(companyId: string): Promise<LiabilityAccount[]> {
  const rows = (await sql`
    SELECT ga.id::TEXT AS id, ga.account_code, ga.account_name, ga.account_subtype
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.account_type = 'liability' AND ga.is_active
       AND (ga.level >= 3 OR NOT EXISTS (
         SELECT 1 FROM gl_accounts child WHERE child.parent_account_id = ga.id AND child.company_id = ${companyId}::UUID
       ))
     ORDER BY ga.account_code
  `) as DbRow[];
  const loans = await readLoanAccountIds(companyId);
  return rows
    .filter((r) => payableSlotAllowed(r.account_subtype == null ? null : String(r.account_subtype), loans.has(String(r.id).toLowerCase())))
    .map((r) => ({ id: String(r.id).toLowerCase(), accountCode: String(r.account_code), accountName: String(r.account_name) }));
}
