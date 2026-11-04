/**
 * Cash pay register / "coin list" (mig 455 — payroll_employees.payment_method).
 *
 * For each cash-paid employee in a run, breaks the net pay into ZAR
 * banknote + coin denominations so the cash-handling team can prepare
 * physical envelopes. Pure deterministic greedy split working in cents
 * to sidestep float drift.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { loanInstalmentBlocker, PayrollLineBlockedError } from './payrollLineBlockers';
import type { OverdrawnLine } from './payrollRunLines';
import type { ValidationResult } from './payrollTypes';

// ZAR denominations in descending order. R200 note down to 5c coin.
// Values stored as integer cents internally.
const DENOMINATIONS_CENTS = [
  20000, // R200
  10000, // R100
  5000,  // R50
  2000,  // R20
  1000,  // R10
  500,   // R5
  200,   // R2
  100,   // R1
  50,    // 50c
  20,    // 20c
  10,    // 10c
  5,     // 5c
] as const;

export interface DenominationCount {
  denomination: number;
  count: number;
}

export interface CashRegisterRow {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  netPay: number;
  denominations: DenominationCount[];
}

export interface CashRegister {
  runId: string;
  rows: CashRegisterRow[];
  totals: {
    totalNet: number;
    employeeCount: number;
    denominations: DenominationCount[];
  };
}

export function splitIntoDenominations(amount: number): DenominationCount[] {
  if (amount < 0) throw new Error('Cannot split negative amount');
  let cents = Math.round(amount * 100);
  return DENOMINATIONS_CENTS.map(d => {
    const count = Math.floor(cents / d);
    cents -= count * d;
    return { denomination: d / 100, count };
  });
}

function sumDenominations(rows: CashRegisterRow[]): DenominationCount[] {
  return DENOMINATIONS_CENTS.map(d => {
    const denom = d / 100;
    const count = rows.reduce((s, row) => {
      const hit = row.denominations.find(x => x.denomination === denom);
      return s + (hit?.count ?? 0);
    }, 0);
    return { denomination: denom, count };
  });
}

export async function cashPayRegisterForRun(
  companyId: string,
  runId: string,
): Promise<CashRegister> {
  const lineRows = (await sql`
    SELECT prh.id AS run_id, prl.employee_id,
           prh.calculation_version,
           e.employee_number,
           e.first_name,
           e.last_name,
           e.payment_method,
           prl.net_pay,
           prl.validation_results
      FROM payroll_run_headers prh
      LEFT JOIN payroll_run_lines prl ON prl.run_id = prh.id
      LEFT JOIN payroll_employees e
        ON e.id = prl.employee_id AND e.company_id = prh.company_id
     WHERE prh.id = ${runId}::uuid
       AND prh.company_id = ${companyId}::uuid
     ORDER BY e.last_name, e.first_name
  `) as DbRow[];
  if (lineRows.length === 0) throw new Error(`Payroll run ${runId} not found in company`);

  const blocked = lineRows.flatMap((r): OverdrawnLine[] => {
    const validations = Array.isArray(r.validation_results) ? r.validation_results as ValidationResult[] : [];
    const result = validations.find((item) => item.code === 'LOAN_INSTALMENT_EXCEEDS_PAY');
    if (!result || typeof result.rawNet !== 'number' || result.rawNet >= 0) return [];
    return [{
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      employeeName: `${String(r.first_name)} ${String(r.last_name)}`.trim(),
      shortfall: -result.rawNet,
      fromLoan: true,
      calculationVersion: r.calculation_version == null ? null : Number(r.calculation_version),
      loans: result.loans ?? [],
    }];
  });
  const blocker = loanInstalmentBlocker(blocked);
  if (blocker) throw new PayrollLineBlockedError(blocker.detail);

  const rows: CashRegisterRow[] = lineRows.filter((r) => r.employee_id && r.payment_method === 'cash').map(r => {
    const netPay = Number(r.net_pay ?? 0);
    return {
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      firstName: String(r.first_name),
      lastName: String(r.last_name),
      netPay,
      denominations: splitIntoDenominations(netPay),
    };
  });

  return {
    runId,
    rows,
    totals: {
      totalNet: rows.reduce((s, r) => s + r.netPay, 0),
      employeeCount: rows.length,
      denominations: sumDenominations(rows),
    },
  };
}
