/**
 * Building blocks for the payroll journal plan: the account lookup, the
 * cost-centre labour split, and the period end-date. Split out of
 * payrollJournalBuilder.ts to keep both files under the 300-line cap; the
 * builder is the assembler, this is the machinery.
 *
 * The account lookup deliberately carries NO `is_active` filter. That column
 * is a picker flag — it decides whether an account appears in a dropdown and
 * says nothing about whether it holds money. The poster has never filtered on
 * it, so the money DOES land in a deactivated account; the builder reports
 * that as an advisory instead. Filtering here would silently understate the
 * journal, which is the casewareExportService defect (R130,000 dropped from a
 * balanced export) in a new place.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getMappingLookup } from './costCentreGlMappingService';
import {
  buildLabourDebitLines,
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
  // No is_active filter: this query resolves where money WILL land, not what a
  // human may pick. See the file header.
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
 * Builds the labour-debit lines, split across per-cost-centre expense accounts
 * where mappings exist. Lifted wholesale from the poster so both paths split
 * identically.
 */
export async function buildLabourLines(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  defaultAccountId: string,
): Promise<Array<{ glAccountId: string; debit: number; description: string }>> {
  const fallback = [{
    glAccountId: defaultAccountId,
    debit: labourDebit,
    description: 'Labour costs — gross pay + statutory employer contributions − ETI',
  }];
  if (labourDebit === 0 || totalGross === 0) return fallback;

  const lineRows = (await sql`
    SELECT prl.employee_id, prl.gross_pay, e.cost_centre_id
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
  `) as Row[];
  if (lineRows.length === 0) return fallback;

  const allocRows = (await sql`
    SELECT a.employee_id, a.cost_centre_id, a.percentage
      FROM payroll_employee_cost_allocations a
      JOIN payroll_run_lines prl ON prl.employee_id = a.employee_id
     WHERE prl.run_id = ${runId}::uuid
       AND a.company_id = ${companyId}::uuid
  `) as Row[];

  const mappings = await getMappingLookup(companyId);
  const employeeCostCentre: Record<string, string | null> = {};
  const runLines: RunLabourLine[] = [];
  for (const r of lineRows) {
    const employeeId = String(r.employee_id);
    const grossShare = Number(r.gross_pay) || 0;
    employeeCostCentre[employeeId] = r.cost_centre_id == null ? null : String(r.cost_centre_id);
    runLines.push({ employeeId, labourAmount: round2((grossShare / totalGross) * labourDebit) });
  }

  const employeeAllocations: Record<string, AllocationShare[]> = {};
  for (const r of allocRows) {
    const employeeId = String(r.employee_id);
    if (!employeeAllocations[employeeId]) employeeAllocations[employeeId] = [];
    employeeAllocations[employeeId]!.push({
      costCentreId: String(r.cost_centre_id),
      percentage: Number(r.percentage) || 0,
    });
  }

  return buildLabourDebitLines({
    runLines, employeeCostCentre, employeeAllocations, mappings, defaultAccountId,
  }).map((l) => ({
    glAccountId: l.glAccountId,
    debit: l.debit,
    description: l.description ?? 'Labour costs',
  }));
}

