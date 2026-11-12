/**
 * Building blocks for the payroll journal plan: the account lookup, the
 * cost-centre labour split, and the period end-date. Split out of
 * payrollJournalBuilder.ts to keep both files under the 300-line cap; the
 * builder is the assembler, this is the machinery.
 *
 * The account lookups deliberately carry NO `is_active` filter. Filtering here
 * would silently drop the line and understate the journal — the
 * casewareExportService defect (R130,000 dropped from a balanced export) in a
 * new place. The flag is read instead, and the builder turns a deactivated
 * target into the `inactive_target_account` BLOCKER, because `postJournalEntry`
 * refuses a posting to a deactivated account (`assertNoInactiveAccountLines`).
 * It must stay a blocker: as an advisory the preview passed a post the live
 * call refused (K-079).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getMappingLookup } from './costCentreGlMappingService';
import {
  buildLabourDebitLines,
  placeLabourRounding,
  type RunLabourLine,
  type AllocationShare,
} from './payrollJournalSplitBuilder';
import type { LabourSourceBucket } from './payrollLabourComparison';
import { taggableCentres, type LabourTagAdvisory } from './payrollCostCentreTags';

type Row = DbRow;

/** Net pay's bank account is not here: it is whichever account holds the BANK role (`resolveBankAccount`). */
export const REQUIRED_PAYROLL_ACCOUNT_CODES = ['5200', '2140', '2150', '2160'] as const;
export const OPTIONAL_PAYROLL_ACCOUNT_CODES = ['2175'] as const;

export interface ResolvedAccount {
  id: string;
  name: string;
  isActive: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Last day of a 1-based month, as YYYY-MM-DD.
 *
 * Built from the calendar parts directly rather than through a Date, because
 * this host is UTC+2 and every Date round-trip through toISOString() on a
 * local-midnight value reports the previous day — which on a December period
 * lands the entry in the wrong year as well as the wrong VAT period.
 */
export function lastDayOfMonthIso(year: number, month: number): string {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = month === 2 && isLeap ? 29 : daysInMonth[month - 1]!;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The `closed_period` blocker for a journal dated `entryDate`, or null. One
 * copy: the plan builder asks it for the run's month, and the approval gate
 * asks it again when a replacement journal is dated elsewhere.
 */
export async function closedPeriodBlocker(companyId: string, entryDate: string): Promise<{ code: string; detail: string } | null> {
  const periodRows = (await sql`
    SELECT status FROM fiscal_periods
    WHERE company_id = ${companyId}::uuid
      AND start_date <= ${entryDate}::date AND end_date >= ${entryDate}::date
    ORDER BY start_date, id
  `) as Row[];
  const closed = periodRows.find((p) => String(p.status) !== 'open');
  return closed
    ? { code: 'closed_period', detail: `The fiscal period covering ${entryDate} is '${String(closed.status)}', so the payroll journal cannot post into it.` }
    : null;
}

export async function resolveAccounts(companyId: string): Promise<Map<string, ResolvedAccount>> {
  const codes = [
    ...REQUIRED_PAYROLL_ACCOUNT_CODES,
    ...OPTIONAL_PAYROLL_ACCOUNT_CODES,
  ] as unknown as string[];
  // No is_active filter: a filtered account would vanish from the journal. The
  // flag is read and the builder blocks on it. See the file header.
  const rows = (await sql`
    SELECT account_code, id, account_name, is_active
    FROM gl_accounts
    WHERE company_id = ${companyId}::uuid
      AND account_code = ANY(${codes})
  `) as Row[];

  const map = new Map<string, ResolvedAccount>();
  for (const r of rows) {
    map.set(String(r.account_code), {
      id: String(r.id),
      name: String(r.account_name ?? ''),
      isActive: r.is_active !== false,
    });
  }
  return map;
}

/**
 * The cost-centre labour accounts a split routed money to, by id, with their
 * code and active flag — so a deactivated one is caught by the plan, as the GL
 * poster would catch it, rather than after approval's status write (K-079).
 */
export async function resolveAccountsById(
  companyId: string,
  ids: string[],
): Promise<Map<string, ResolvedAccount & { code: string }>> {
  const map = new Map<string, ResolvedAccount & { code: string }>();
  if (ids.length === 0) return map;
  const rows = (await sql`
    SELECT id, account_code, account_name, is_active
    FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])
  `) as Row[];
  for (const r of rows) {
    map.set(String(r.id), {
      id: String(r.id),
      code: String(r.account_code ?? ''),
      name: String(r.account_name ?? ''),
      isActive: r.is_active !== false,
    });
  }
  return map;
}

/**
 * Builds the labour-debit lines, split across per-cost-centre expense accounts
 * where mappings exist. Lifted wholesale from the poster so both paths split
 * identically.
 *
 * K-079: each employee carries a gross-share (with a non-cash benefit in the run,
 * the rest by gross share and its own line's SDL) of the cost BEFORE ETI
 * (labourDebit + etiUsed) less their own share of `etiUsed`, apportioned by
 * the ETI on their run line — ETI is earned by the low-wage staff, so spreading
 * it by gross moved cost between cost-centre accounts. The per-employee
 * amounts are then tied to `labourDebit` to the cent (residual on the largest),
 * because the GL rejects a journal that is out by even R0.01.
 *
 * Each line carries the employee's cost centre as `cc1Id` (Hein 2026-11-02).
 * `createJournalEntry` refuses a CC1 that is not an ACTIVE `cc_type = 'cc1'`
 * centre, so a centre that is inactive, a CC2, or unreadable posts UNTAGGED on
 * the account its mapping picks, and `advisory` names it — a dimension tag
 * never blocks payroll. The read holds the centres FOR SHARE (lock order:
 * `payrollCostCentreTags`), so in approval a deactivation cannot commit
 * between this plan and the GL's own check.
 */
export async function buildLabourLines(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  defaultAccountId: string,
  etiUsed: number,
  employerMedical: ReadonlyMap<string, number> = new Map(),
): Promise<LabourLines> {
  const fallback: LabourLines = {
    lines: [{
      glAccountId: defaultAccountId,
      cc1Id: null,
      debit: labourDebit,
      description: 'Labour costs — gross pay + employer contributions (UIF, SDL, medical scheme) − ETI',
    }],
    advisory: null,
    bySource: [{ glAccountId: defaultAccountId, centreId: null, taggable: false, debit: labourDebit }],
  };
  if (labourDebit === 0) return fallback;

  const lineRows = (await sql`
    SELECT prl.employee_id, prl.gross_pay, prl.eti, prl.sdl, e.cost_centre_id, COALESCE((SELECT SUM((item->>'amount')::numeric)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array'
                         THEN prl.component_breakdown ELSE '[]'::jsonb END) item
                      WHERE item->>'isNonCash' = 'true'), 0) AS non_cash
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
     ORDER BY prl.employee_id
  `) as Row[];
  if (lineRows.length === 0) return fallback;

  const allocRows = (await sql`
    SELECT a.employee_id, a.cost_centre_id, a.percentage
      FROM payroll_employee_cost_allocations a
      JOIN payroll_run_lines prl ON prl.employee_id = a.employee_id
     WHERE prl.run_id = ${runId}::uuid
       AND a.company_id = ${companyId}::uuid
     ORDER BY a.employee_id, a.cost_centre_id
  `) as Row[];

  const mappings = await getMappingLookup(companyId);
  const employeeCostCentre: Record<string, string | null> = {};
  const runLines: RunLabourLine[] = [];
  const costBeforeEti = labourDebit + etiUsed;
  const lineEti = lineRows.reduce((s, r) => s + (Number(r.eti) || 0), 0);
  // SDL is on remuneration, which a non-cash benefit (isNonCash items) is, outside gross: with one in the run each
  // line carries its own SDL. With none sdlPart is nil and the split is the gross-share one, unchanged.
  const totalNonCash = lineRows.reduce((s, r) => s + (Number(r.non_cash) || 0), 0);
  // No cash gross: nothing to share by gross, so one line, unless benefits alone carry SDL (each line its own).
  if (totalGross === 0 && totalNonCash === 0) return fallback;
  const sdlPart = totalNonCash > 0 ? lineRows.reduce((s, r) => s + (Number(r.sdl) || 0), 0) : 0;
  // The employer's non-cash 3810 medical contribution is each employee's own cost (payrollJournalEmployerMedical).
  const medicalPart = lineRows.reduce((s, r) => s + (employerMedical.get(String(r.employee_id)) ?? 0), 0);
  for (const r of lineRows) {
    const employeeId = String(r.employee_id);
    const grossShare = totalGross === 0 ? 0 : (Number(r.gross_pay) || 0) / totalGross;
    // No ETI on the lines (an imported or hand-edited header): fall back to gross.
    const etiShare = lineEti > 0 ? (Number(r.eti) || 0) / lineEti : grossShare;
    employeeCostCentre[employeeId] = r.cost_centre_id == null ? null : String(r.cost_centre_id);
    runLines.push({
      employeeId,
      labourAmount: round2(grossShare * (costBeforeEti - sdlPart - medicalPart) + (sdlPart > 0 ? Number(r.sdl) || 0 : 0)
        + (employerMedical.get(employeeId) ?? 0) - etiShare * etiUsed),
    });
  }
  // Both reads are ORDER BY'd (the allocation split puts its own residual on
  // the LAST share), and the rounding tie is broken by employee — so the split,
  // the posted journal and the plan hash never depend on heap order (R2-5).
  //
  // Neither read had an ORDER BY before that, and the tie went to the first
  // largest line read — heap order, never fixed and not reproducible now. A
  // journal posted then may carry those rounding cents on another cost-centre
  // account than this plan does. That is why the approval gate compares a
  // posted journal's labour as a TOTAL, never account by account
  // (payrollApprovalGate#figures).
  const tied = placeLabourRounding(runLines, labourDebit);

  const employeeAllocations: Record<string, AllocationShare[]> = {};
  for (const r of allocRows) {
    const employeeId = String(r.employee_id);
    if (!employeeAllocations[employeeId]) employeeAllocations[employeeId] = [];
    employeeAllocations[employeeId]!.push({
      costCentreId: String(r.cost_centre_id),
      percentage: Number(r.percentage) || 0,
    });
  }

  // The centres that carry labour: an employee's allocations, else their own centre.
  const centres = [...new Set(tied.flatMap((l) => {
    const allocations = employeeAllocations[l.employeeId] ?? [];
    if (allocations.length > 0) return allocations.map((a) => a.costCentreId);
    const own = employeeCostCentre[l.employeeId];
    return own ? [own] : [];
  }))];
  const { taggable, advisory } = await taggableCentres(companyId, centres);

  const split = { runLines: tied, employeeCostCentre, employeeAllocations, mappings, defaultAccountId };
  const lines = buildLabourDebitLines({ ...split, taggableCostCentres: taggable })
    .map((l) => ({ glAccountId: l.glAccountId, cc1Id: l.cc1Id, debit: l.debit, description: l.description }));
  // The same split with every centre kept apart, for the approval gate's comparison (payrollLabourComparison).
  const bySource = buildLabourDebitLines({ ...split, taggableCostCentres: new Set(centres) })
    .map((l) => ({ glAccountId: l.glAccountId, centreId: l.cc1Id, taggable: l.cc1Id !== null && taggable.has(l.cc1Id), debit: l.debit }));
  return { lines, advisory, bySource };
}

export interface LabourLines {
  lines: Array<{ glAccountId: string; cc1Id: string | null; debit: number; description: string }>;
  /** `labour_cost_centre_untagged`, when a centre carrying labour cannot be a CC1 tag. */
  advisory: LabourTagAdvisory;
  /** The labour per (account, source centre), untaggable centres kept apart — the gate's comparison only. */
  bySource: LabourSourceBucket[];
}
