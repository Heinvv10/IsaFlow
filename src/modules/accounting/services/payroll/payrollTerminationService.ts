/**
 * Payroll Termination Service
 *
 * Synthesizes per-employee termination components (leave pay-out, notice pay,
 * severance) that flow through the existing payroll run calculator the same
 * way regular earning components do — they become part of `gross_pay`, get
 * taxed via PAYE, and land on the payslip.
 *
 * SARS source codes assigned per BRS v25.2:
 *   3810 — Leave pay
 *   3605 — Annual payment / gratuity (used for notice pay — BCEA s37)
 *   3901 — Gratuities / severance pay (lump sum — may require a tax directive)
 *
 * Pure logic: no DB access. Callers assemble inputs from the DB and pass them.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateTerminationPayout } from '@/modules/accounting/services/core/leaveService';
import type { EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

export type TerminationReason =
  | 'resignation'
  | 'dismissal'
  | 'retrenchment'
  | 'retirement'
  | 'end_of_contract'
  | 'death';

export interface TerminationInput {
  /** Gross salary for one month (earning components only, pre-tax). */
  monthlySalary: number;
  /** Annual-leave days accrued-unused at termination (use leave_balances.balance). */
  unusedLeaveDays: number;
  /** Notice period per contract (days). */
  noticePeriodDays: number;
  /** Days of notice actually served by the employee. */
  servedNoticeDays: number;
  /** Severance rate — weeks of salary per year of service (BCEA s41 default = 1 week/yr for retrenchments). */
  severanceWeeksPerYear: number;
  /** Years of completed service. */
  yearsOfService: number;
  /** If false, omit the leave pay-out from the synthesized components (user may choose to pay separately). */
  includeLeavePayout: boolean;
  /** Termination reason — used to decide whether severance applies (BCEA s41 only requires severance for retrenchment). */
  reason: TerminationReason;
}

export interface TerminationPreview {
  leavePayout: number;
  noticePay: number;
  severancePay: number;
  total: number;
}

// ─── Synthetic components ─────────────────────────────────────────────────────

const LEAVE_PAY: PayrollComponent = {
  id: 'synthetic:termination:leave-payout',
  name: 'Leave Pay-Out (Termination)',
  sarsSourceCode: '3810',
  componentType: 'earning',
  isTaxable: true,
  isUifApplicable: true,  // BCEA: leave pay on termination is remuneration for UIF purposes
  isSdlApplicable: true,
};

const NOTICE_PAY: PayrollComponent = {
  id: 'synthetic:termination:notice-pay',
  name: 'Notice Pay (Termination)',
  sarsSourceCode: '3605',
  componentType: 'earning',
  isTaxable: true,
  isUifApplicable: true,
  isSdlApplicable: true,
};

const SEVERANCE_PAY: PayrollComponent = {
  id: 'synthetic:termination:severance',
  name: 'Severance Pay',
  sarsSourceCode: '3901',
  componentType: 'earning',
  // Severance is a lump-sum payment taxed by SARS directive — taxable in
  // principle but the directive determines the rate. For MVP we surface it
  // as regular taxable remuneration; in practice the user should obtain a
  // tax directive (PRD-02 Phase 3 tax-directives page) and adjust manually.
  isTaxable: true,
  isUifApplicable: false,  // Severance is NOT UIF/SDL leviable (BCEA/SDL Act)
  isSdlApplicable: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Severance only applies for retrenchment per BCEA s41. */
function severanceApplies(reason: TerminationReason): boolean {
  return reason === 'retrenchment';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeTerminationPreview(input: TerminationInput): TerminationPreview {
  const raw = calculateTerminationPayout({
    monthlySalary: input.monthlySalary,
    unusedLeaveDays: input.unusedLeaveDays,
    noticePeriodDays: input.noticePeriodDays,
    servedNoticeDays: input.servedNoticeDays,
    severanceWeeks: input.severanceWeeksPerYear,
    yearsOfService: input.yearsOfService,
  });
  const leavePayout = input.includeLeavePayout ? raw.leavePayout : 0;
  const severancePay = severanceApplies(input.reason) ? raw.severancePay : 0;
  const noticePay = raw.noticePay;
  return {
    leavePayout,
    noticePay,
    severancePay,
    total: Math.round((leavePayout + noticePay + severancePay) * 100) / 100,
  };
}

export function buildTerminationComponents(input: TerminationInput): EmployeeComponent[] {
  const preview = computeTerminationPreview(input);
  const out: EmployeeComponent[] = [];
  if (preview.leavePayout > 0) out.push({ component: LEAVE_PAY, amount: preview.leavePayout });
  if (preview.noticePay > 0) out.push({ component: NOTICE_PAY, amount: preview.noticePay });
  if (preview.severancePay > 0) out.push({ component: SEVERANCE_PAY, amount: preview.severancePay });
  return out;
}

/** Years of service from hire date to end date (inclusive of end). */
export function yearsOfService(startIso: string, endIso: string): number {
  const s = new Date(`${startIso.slice(0, 10)}T00:00:00Z`);
  const e = new Date(`${endIso.slice(0, 10)}T00:00:00Z`);
  if (e <= s) return 0;
  const ms = e.getTime() - s.getTime();
  return Math.max(0, ms / (365.25 * 24 * 60 * 60 * 1000));
}

// ─── DB layer ────────────────────────────────────────────────────────────────

export interface TerminationDetailsRow {
  reason: TerminationReason | null;
  noticePeriodDays: number | null;
  servedNoticeDays: number | null;
  severanceWeeksPerYear: number | null;
  includeLeavePayout: boolean;
}

export async function getTerminationDetails(
  companyId: string,
  employeeId: string,
): Promise<TerminationDetailsRow | null> {
  const rows = (await sql`
    SELECT
      termination_reason,
      termination_notice_period_days,
      termination_served_notice_days,
      termination_severance_weeks_per_year,
      termination_include_leave_payout
    FROM   payroll_employees
    WHERE  id         = ${employeeId}::uuid
      AND  company_id = ${companyId}::uuid
  `) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    reason: row.termination_reason ? (String(row.termination_reason) as TerminationReason) : null,
    noticePeriodDays: row.termination_notice_period_days != null ? Number(row.termination_notice_period_days) : null,
    servedNoticeDays: row.termination_served_notice_days != null ? Number(row.termination_served_notice_days) : null,
    severanceWeeksPerYear: row.termination_severance_weeks_per_year != null ? Number(row.termination_severance_weeks_per_year) : null,
    includeLeavePayout: row.termination_include_leave_payout !== false,
  };
}

export interface TerminationDetailsInput {
  reason: TerminationReason | null;
  noticePeriodDays: number | null;
  servedNoticeDays: number | null;
  severanceWeeksPerYear: number | null;
  includeLeavePayout: boolean;
}

export async function setTerminationDetails(
  companyId: string,
  employeeId: string,
  input: TerminationDetailsInput,
): Promise<void> {
  log.info('Updating employee termination details', { companyId, employeeId, reason: input.reason }, 'payrollTerminationService');
  await sql`
    UPDATE payroll_employees
       SET termination_reason                   = ${input.reason},
           termination_notice_period_days       = ${input.noticePeriodDays},
           termination_served_notice_days       = ${input.servedNoticeDays},
           termination_severance_weeks_per_year = ${input.severanceWeeksPerYear},
           termination_include_leave_payout     = ${input.includeLeavePayout}
     WHERE id         = ${employeeId}::uuid
       AND company_id = ${companyId}::uuid
  `;
}

/**
 * Fetch the accrued-minus-taken balance for the annual-leave type for
 * (employeeId, balanceYear). Returns 0 when no balance row exists.
 */
export async function getAnnualLeaveBalance(
  companyId: string,
  employeeId: string,
  balanceYear: number,
): Promise<number> {
  const rows = (await sql`
    SELECT plb.balance
    FROM   payroll_leave_balances plb
    JOIN   payroll_leave_types    plt ON plt.id = plb.leave_type_id
    JOIN   payroll_employees      pe  ON pe.id  = plb.employee_id
    WHERE  pe.company_id   = ${companyId}::uuid
      AND  plt.company_id  = ${companyId}::uuid
      AND  plb.employee_id = ${employeeId}::uuid
      AND  plb.balance_year = ${balanceYear}
      AND  plt.bcea_type = 'annual'
    ORDER BY plb.balance DESC
    LIMIT 1
  `) as DbRow[];
  return rows[0] ? Number(rows[0].balance ?? 0) : 0;
}
