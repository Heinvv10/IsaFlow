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
 *   - applyTaxDirective: these centres (`readEmployeeLabourSplit`, from the
 *     directive's employee_id read WITHOUT a lock — it is set at creation and
 *     never updated: updateTaxDirective changes status and issued date only)
 *     → directive row FOR SHARE → payment row → GL (centres, held).
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
     FOR SHARE OF cc
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const taggable = new Set<string>();
  const refused: string[] = [];
  for (const id of [...ids].sort()) {
    const r = byId.get(id);
    if (r && String(r.cc_type) === 'cc1' && r.is_active === true) taggable.add(id);
    else refused.push(!r ? `${id} (not found)` : r.is_active !== true ? `${String(r.code)} (inactive)` : `${String(r.code)} (a ${String(r.cc_type).toUpperCase()}, not a CC1)`);
  }
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
  taggable: ReadonlySet<string>;
  advisory: LabourTagAdvisory;
}

/** Reads (and share-locks the centres of) one employee's split, company-scoped. An unknown employee has no centre. */
export async function readEmployeeLabourSplit(companyId: string, employeeId: string): Promise<EmployeeLabourSplit> {
  const emp = (await sql`
    SELECT cost_centre_id FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
  `) as DbRow[];
  const allocations = ((await sql`
    SELECT cost_centre_id, percentage FROM payroll_employee_cost_allocations
     WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
     ORDER BY cost_centre_id
  `) as DbRow[]).map((r) => ({ costCentreId: String(r.cost_centre_id), percentage: Number(r.percentage) || 0 }));
  const costCentreId = emp[0]?.cost_centre_id == null ? null : String(emp[0].cost_centre_id);
  const centres = allocations.length > 0 ? allocations.map((a) => a.costCentreId) : costCentreId ? [costCentreId] : [];
  const { taggable, advisory } = await taggableCentres(companyId, [...new Set(centres)]);
  return { employeeId, costCentreId, allocations, mappings: await getMappingLookup(companyId), taggable, advisory };
}

/**
 * Pure: `amount` of one employee's labour as debit lines, by the pay run's rule
 * (buildLabourDebitLines): allocations split it, the mapping picks each
 * account (unmapped → `defaultAccountId`), a taggable centre is the line's CC1.
 */
export function employeeLabourLines(split: EmployeeLabourSplit, amount: number, defaultAccountId: string, description: string): JournalLineInput[] {
  return buildLabourDebitLines({
    runLines: [{ employeeId: split.employeeId, labourAmount: amount }],
    employeeCostCentre: { [split.employeeId]: split.costCentreId },
    employeeAllocations: split.allocations.length > 0 ? { [split.employeeId]: split.allocations } : {},
    mappings: split.mappings,
    defaultAccountId,
    taggableCostCentres: split.taggable,
  }).map((l) => ({ glAccountId: l.glAccountId, debit: l.debit, credit: 0, description, ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}) }));
}
