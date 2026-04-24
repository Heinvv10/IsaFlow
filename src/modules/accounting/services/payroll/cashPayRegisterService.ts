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
  const runRows = (await sql`
    SELECT id FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (runRows.length === 0) throw new Error(`Payroll run ${runId} not found in company`);

  const lineRows = (await sql`
    SELECT prl.employee_id,
           e.employee_number,
           e.first_name,
           e.last_name,
           prl.net_pay
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
       AND e.payment_method = 'cash'
     ORDER BY e.last_name, e.first_name
  `) as DbRow[];

  const rows: CashRegisterRow[] = lineRows.map(r => {
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
