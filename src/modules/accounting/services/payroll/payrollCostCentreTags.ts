/**
 * Which cost centres a payroll labour line may carry as CC1, and the labour
 * lines of ONE employee's amount — shared by the pay-run journal
 * (payrollJournalParts#buildLabourLines) and a SARS directive paid outside
 * payroll (taxDirectivePaymentService#applyTaxDirective), so both tag by one
 * rule (Hein 2026-11-02: payroll labour carries the employee's CC1).
 *
 * LOCK ORDER (census, follow-up A of PR #1065). `taggableCentres` holds the
 * centres FOR SHARE, as the GL's own check (journalCostCentreValidation) does
 * when the journal is written. Every payroll path takes them BEFORE the
 * directive rows:
 *   - approvePayrollRun: company approval lock → run header → journal chain →
 *     these centres (plan) → directive rows FOR SHARE
 *     (claimRunSeveranceDirectives) → payment row → GL (centres, held).
 *   - applyTaxDirective (taxDirectiveLabour): these centres
 *     (`readEmployeeLabourSplit`, from the directive's employee_id read WITHOUT
 *     a lock — it is set at creation and never updated: updateTaxDirective
 *     changes status and issued date only) → directive row FOR SHARE → the
 *     split re-read under those locks, refused if it names a centre not locked
 *     first → payment row → GL (centres, held).
 * Within one statement the rows are locked in id order (ORDER BY cc.id), so two
 * lockers of overlapping centre sets take them in one order.
 * Taken the other way round (directive, then the GL's share lock after the
 * payment row) a dimension edit queued for a centre's row lock could close a
 * cycle: approval holding the centre and waiting on the payment row, the edit
 * queued behind approval, the directive payment holding the payment row and
 * queued behind the edit. Writers: the dimension master edit (advisory lock,
 * then the centre row) locks no directive, header, journal or payment row;
 * updateTaxDirective takes the directive FOR UPDATE and nothing after it. A
 * preview (GET journal-plan, MCP dry run) holds the centres only for its own
 * read-only request.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { getMappingLookup } from './costCentreGlMappingService';
import { buildLabourDebitLines, type AllocationShare } from './payrollJournalSplitBuilder';

export type LabourTagAdvisory = { code: string; detail: string } | null;

/**
 * Which of `ids` the GL accepts as a new CC1 tag — the rule of
 * `journalCostCentreValidation#assertJournalAnalysisDimensions`: this company's,
 * `cc_type = 'cc1'`, active — and the `labour_cost_centre_untagged` advisory
 * naming the rest (their labour posts untagged on the same account; a tag
 * never blocks payroll). FOR SHARE: see the lock order above.
 */
export async function taggableCentres(companyId: string, ids: string[]): Promise<{ taggable: Set<string>; advisory: LabourTagAdvisory }> {
  if (ids.length === 0) return { taggable: new Set(), advisory: null };
  const rows = (await sql`
    SELECT cc.id, cc.code, cc.cc_type, cc.is_active FROM cost_centres cc
     WHERE cc.company_id = ${companyId}::uuid AND cc.id = ANY(${ids}::uuid[])
     ORDER BY cc.id
     FOR SHARE OF cc
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const taggable = new Set<string>();
  const refused: string[] = [];
  let unknown = 0;
  for (const id of [...ids].sort()) {
    const r = byId.get(id);
    if (r && String(r.cc_type) === 'cc1' && r.is_active === true) taggable.add(id);
    else if (!r) unknown += 1; // another company's id, or none: never echoed
    else refused.push(r.is_active !== true ? `${String(r.code)} (inactive)` : `${String(r.code)} (a ${String(r.cc_type).toUpperCase()}, not a CC1)`);
  }
  if (unknown > 0) refused.push(unknown === 1 ? 'one not in this company' : `${unknown} not in this company`);
  return {
    taggable,
    advisory: refused.length === 0 ? null : {
      code: 'labour_cost_centre_untagged',
      detail: `Labour for cost centre${refused.length > 1 ? 's' : ''} ${refused.join(', ')} posts WITHOUT a CC1 tag, on the same account: `
        + 'the ledger tags a line only with an active CC1 cost centre. Budgets by CC1 will not see this cost.',
    },
  };
}

/** One employee's cost-centre split: own centre, allocations, the mapping, and the centres it may tag (held FOR SHARE). */
export interface EmployeeLabourSplit {
  employeeId: string;
  costCentreId: string | null;
  allocations: AllocationShare[];
  mappings: Record<string, string>;
  /** Every centre the split names — the rows this read share-locked. */
  centres: ReadonlySet<string>;
  taggable: ReadonlySet<string>;
  advisories: Array<{ code: string; detail: string }>;
}

/**
 * Reads (and share-locks the centres of) one employee's split, company-scoped.
 * An unknown employee has no centre. The rule of a SARS directive paid outside
 * payroll, which mapping or tagging must never block: a centre mapped to a
 * DEACTIVATED account posts to the default account instead, its CC1 kept, with
 * `labour_account_inactive` (a pay run refuses that target as a plan blocker).
 *
 * `within`: the centres a first read locked. When the split now names a centre
 * outside them, null is returned BEFORE it is locked, so the caller can refuse
 * without taking a centre lock after its directive lock.
 */
export async function readEmployeeLabourSplit(
  companyId: string, employeeId: string, within?: ReadonlySet<string>,
): Promise<EmployeeLabourSplit | null> {
  const emp = (await sql`
    SELECT cost_centre_id FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
  `) as DbRow[];
  const allocations = ((await sql`
    SELECT cost_centre_id, percentage FROM payroll_employee_cost_allocations
     WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
     ORDER BY cost_centre_id
  `) as DbRow[]).map((r) => ({ costCentreId: String(r.cost_centre_id), percentage: Number(r.percentage) || 0 }));
  const costCentreId = emp[0]?.cost_centre_id == null ? null : String(emp[0].cost_centre_id);
  const centres = new Set(allocations.length > 0 ? allocations.map((a) => a.costCentreId) : costCentreId ? [costCentreId] : []);
  if (within && [...centres].some((c) => !within.has(c))) return null;
  const { taggable, advisory } = await taggableCentres(companyId, [...centres]);
  const mappings = await getMappingLookup(companyId);
  const advisories = advisory ? [advisory] : [];
  const mapped = [...new Set([...centres].map((c) => mappings[c]).filter((a): a is string => a != null))];
  const inactive = mapped.length === 0 ? [] : (await sql`
    SELECT id, account_code FROM gl_accounts
     WHERE company_id = ${companyId}::uuid AND id = ANY(${mapped}::uuid[]) AND is_active = false
     ORDER BY account_code
  `) as DbRow[];
  if (inactive.length > 0) {
    const off = new Set(inactive.map((r) => String(r.id)));
    for (const c of centres) if (mappings[c] && off.has(mappings[c]!)) delete mappings[c];
    advisories.push({
      code: 'labour_account_inactive',
      detail: `Labour mapped to deactivated account${inactive.length > 1 ? 's' : ''} ${inactive.map((r) => String(r.account_code)).join(', ')} `
        + 'posts to the default labour account instead, with its cost centre kept. Reactivate the account or change the mapping.',
    });
  }
  return { employeeId, costCentreId, allocations, mappings, centres, taggable, advisories };
}

/**
 * Pure: `amount` of one employee's labour as debit lines, by the pay run's rule
 * (buildLabourDebitLines): allocations split it, the mapping picks each
 * account (unmapped → `defaultAccountId`), a taggable centre is the line's CC1.
 * A zero amount gives one zero line on the default account, as the single
 * line before this split did (the GL refuses it the same way).
 */
export function employeeLabourLines(split: EmployeeLabourSplit, amount: number, defaultAccountId: string, description: string): JournalLineInput[] {
  if (amount === 0) return [{ glAccountId: defaultAccountId, debit: 0, credit: 0, description }];
  return buildLabourDebitLines({
    runLines: [{ employeeId: split.employeeId, labourAmount: amount }],
    employeeCostCentre: { [split.employeeId]: split.costCentreId },
    employeeAllocations: split.allocations.length > 0 ? { [split.employeeId]: split.allocations } : {},
    mappings: split.mappings,
    defaultAccountId,
    taggableCostCentres: split.taggable,
  }).map((l) => ({ glAccountId: l.glAccountId, debit: l.debit, credit: 0, description, ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}) }));
}
