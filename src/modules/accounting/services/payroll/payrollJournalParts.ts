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
  labourRoundingSlackCents,
  placeLabourRounding,
  type RunLabourLine,
  type AllocationShare,
} from './payrollJournalSplitBuilder';

type Row = DbRow;

export const REQUIRED_PAYROLL_ACCOUNT_CODES = ['5200', '2140', '2150', '2160', '1110'] as const;
export const OPTIONAL_PAYROLL_ACCOUNT_CODES = ['2175'] as const;

export interface ResolvedAccount {
  id: string;
  name: string;
  isActive: boolean;
}

type LabourLine = { glAccountId: string; debit: number; description: string };

/** See labourRoundingSlack. */
export interface LabourRoundingSlack {
  accountIds: string[];
  cents: number;
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
 * K-079: each employee carries a gross-share of the cost BEFORE ETI
 * (labourDebit + etiUsed) less their own share of `etiUsed`, apportioned by
 * the ETI on their run line — ETI is earned by the low-wage staff, so spreading
 * it by gross moved cost between cost-centre accounts. The per-employee
 * amounts are then tied to `labourDebit` to the cent (residual on the largest),
 * because the GL rejects a journal that is out by even R0.01.
 */
export async function buildLabourLines(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  defaultAccountId: string,
  etiUsed: number,
): Promise<LabourLine[]> {
  return (await splitLabour(companyId, runId, labourDebit, totalGross, defaultAccountId, etiUsed)).lines;
}

/**
 * The cents of this run's labour split whose account depended on read order
 * before the reads were ordered, and the accounts the split can route to — what
 * the approval gate may overlook between a journal posted then and the plan
 * now (payrollApprovalGate). Nothing when the company has no 5200.
 */
export async function labourRoundingSlack(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  etiUsed: number,
): Promise<LabourRoundingSlack> {
  const defaultAccountId = (await resolveAccounts(companyId)).get('5200')?.id;
  if (!defaultAccountId) return { accountIds: [], cents: 0 };
  return (await splitLabour(companyId, runId, labourDebit, totalGross, defaultAccountId, etiUsed)).slack;
}

async function splitLabour(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  defaultAccountId: string,
  etiUsed: number,
): Promise<{ lines: LabourLine[]; slack: LabourRoundingSlack }> {
  const fallback = {
    lines: [{
      glAccountId: defaultAccountId,
      debit: labourDebit,
      description: 'Labour costs — gross pay + statutory employer contributions − ETI',
    }],
    slack: { accountIds: [defaultAccountId], cents: 0 },
  };
  if (labourDebit === 0 || totalGross === 0) return fallback;

  const lineRows = (await sql`
    SELECT prl.employee_id, prl.gross_pay, prl.eti, e.cost_centre_id
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
  for (const r of lineRows) {
    const employeeId = String(r.employee_id);
    const grossShare = (Number(r.gross_pay) || 0) / totalGross;
    // No ETI on the lines (an imported or hand-edited header): fall back to gross.
    const etiShare = lineEti > 0 ? (Number(r.eti) || 0) / lineEti : grossShare;
    employeeCostCentre[employeeId] = r.cost_centre_id == null ? null : String(r.cost_centre_id);
    runLines.push({ employeeId, labourAmount: round2(grossShare * costBeforeEti - etiShare * etiUsed) });
  }
  // Both reads are ORDER BY'd (the allocation split puts its own residual on
  // the LAST share), and the rounding tie is broken by employee — so the split,
  // the posted journal and the plan hash never depend on heap order (R2-5).
  //
  // Neither read had an ORDER BY before that, and the tie went to the first
  // largest line read, so a journal posted earlier put those cents wherever
  // the heap's order did — an order that was never fixed and cannot be
  // reproduced now. Such a journal can therefore differ from this plan by the
  // rounding cents, between labour accounts only. `slack` measures them, and
  // the approval gate does not call that difference a recalculation.
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

  const lines = buildLabourDebitLines({
    runLines: tied, employeeCostCentre, employeeAllocations, mappings, defaultAccountId,
  }).map((l) => ({
    glAccountId: l.glAccountId,
    debit: l.debit,
    description: l.description ?? 'Labour costs',
  }));
  const centres = [...Object.values(employeeCostCentre), ...allocRows.map((r) => String(r.cost_centre_id))];
  const accountIds = new Set([defaultAccountId, ...centres.map((c) => (c == null ? undefined : mappings[c]) ?? defaultAccountId)]);
  return {
    lines,
    slack: { accountIds: [...accountIds], cents: labourRoundingSlackCents(runLines, tied, employeeAllocations) },
  };
}

