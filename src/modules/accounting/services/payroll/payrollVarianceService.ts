/**
 * Payroll variance — month-over-month diff for a payroll run.
 *
 * For a given run we find the immediately preceding run for the same
 * company and emit per-employee + summary deltas with severity flags.
 *
 * Severity rules (a single line is the highest of its column severities):
 *   • new       — employee in current run, not in prior
 *   • removed   — employee in prior run, not in current
 *   • >= ±20%   — 'high' (default surprise threshold)
 *   • >= ±5%    — 'medium'
 *   • else      — 'low' (no flag, change still shown)
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { runOrderKeySql } from './payrollRunOrder';

export type VarianceSeverity = 'new' | 'removed' | 'high' | 'medium' | 'low';

export interface VarianceTotals {
  current: number;
  prior: number;
  diff: number;       // current - prior
  pct: number | null; // (current-prior)/prior; null when prior=0 and current=0
}

export interface EmployeeVariance {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: 'unchanged' | 'new' | 'removed' | 'changed';
  severity: VarianceSeverity;
  grossPay: VarianceTotals;
  paye: VarianceTotals;
  netPay: VarianceTotals;
}

export interface PayrollVariance {
  runId: string;
  priorRunId: string | null;
  currentPeriod: { month: number; year: number };
  priorPeriod: { month: number; year: number } | null;
  totals: {
    grossPay: VarianceTotals;
    paye: VarianceTotals;
    uif: VarianceTotals;
    sdl: VarianceTotals;
    netPay: VarianceTotals;
    employeeCount: VarianceTotals;
  };
  employees: EmployeeVariance[];
}

const HIGH_PCT = 0.20;
const MEDIUM_PCT = 0.05;

function diffTotals(current: number, prior: number): VarianceTotals {
  const diff = round2(current - prior);
  let pct: number | null;
  if (prior === 0) {
    pct = current === 0 ? null : null; // Inf — represented as null + treat as new/removed by row status
  } else {
    pct = (current - prior) / prior;
  }
  return { current: round2(current), prior: round2(prior), diff, pct };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function severityFromPct(pct: number | null): VarianceSeverity {
  if (pct === null) return 'low';
  const abs = Math.abs(pct);
  if (abs >= HIGH_PCT) return 'high';
  if (abs >= MEDIUM_PCT) return 'medium';
  return 'low';
}

function maxSeverity(...sevs: VarianceSeverity[]): VarianceSeverity {
  const order: Record<VarianceSeverity, number> = {
    removed: 5, new: 4, high: 3, medium: 2, low: 1,
  };
  return sevs.reduce((a, b) => order[a] >= order[b] ? a : b);
}

export async function getPayrollRunVariance(
  runId: string,
  companyId: string,
): Promise<PayrollVariance> {
  // 1. Current run header
  const currentRows = (await sql`
    SELECT id, period_month, period_year,
           total_gross, total_paye, total_uif, total_sdl, total_net, employee_count
      FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (currentRows.length === 0 || !currentRows[0]) {
    throw new Error('Payroll run not found');
  }
  const cur = currentRows[0];
  const curMonth = Number(cur.period_month);
  const curYear = Number(cur.period_year);

  // 2. Prior run for same company: the latest earlier run (pay order) of the same kind and frequency, so a regular
  //    run is compared with the previous regular run, not an off-cycle bonus of the month before (wave 6 FQb1).
  const priorRows = (await sql`
    SELECT p.id, p.period_month, p.period_year,
           p.total_gross, p.total_paye, p.total_uif, p.total_sdl, p.total_net, p.employee_count
      FROM payroll_run_headers p
      JOIN payroll_run_headers c ON c.id = ${runId}::uuid AND c.company_id = p.company_id
     WHERE p.company_id = ${companyId}::uuid
       AND p.run_kind = c.run_kind AND p.pay_frequency = c.pay_frequency
       AND ${runOrderKeySql('p')} < ${runOrderKeySql('c')}
       AND p.status NOT IN ('cancelled', 'draft')
     ORDER BY ${runOrderKeySql('p')} DESC
     LIMIT 1
  `) as DbRow[];
  const prior = priorRows[0] ?? null;

  const totals = {
    grossPay:      diffTotals(Number(cur.total_gross),    Number(prior?.total_gross    ?? 0)),
    paye:          diffTotals(Number(cur.total_paye),     Number(prior?.total_paye     ?? 0)),
    uif:           diffTotals(Number(cur.total_uif),      Number(prior?.total_uif      ?? 0)),
    sdl:           diffTotals(Number(cur.total_sdl),      Number(prior?.total_sdl      ?? 0)),
    netPay:        diffTotals(Number(cur.total_net),      Number(prior?.total_net      ?? 0)),
    employeeCount: diffTotals(Number(cur.employee_count), Number(prior?.employee_count ?? 0)),
  };

  // 3. Per-employee lines for both runs
  const curLineRows = await sql`
    SELECT prl.employee_id, prl.gross_pay, prl.paye, prl.net_pay,
           e.employee_number, e.first_name, e.last_name
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
  `;

  type LineRow = {
    employee_id: string; gross_pay: string | number;
    paye: string | number; net_pay: string | number;
    employee_number: string; first_name: string; last_name: string;
  };
  const curMap = new Map<string, LineRow>(
    (curLineRows as LineRow[]).map((r) => [String(r.employee_id), r]),
  );

  let priorMap = new Map<string, LineRow>();
  if (prior) {
    const priorLineRows = await sql`
      SELECT prl.employee_id, prl.gross_pay, prl.paye, prl.net_pay,
             e.employee_number, e.first_name, e.last_name
        FROM payroll_run_lines prl
        JOIN payroll_employees e ON e.id = prl.employee_id
       WHERE prl.run_id = ${prior.id}::uuid
    `;
    priorMap = new Map<string, LineRow>(
      (priorLineRows as LineRow[]).map((r) => [String(r.employee_id), r]),
    );
  }

  const allIds = new Set<string>([...curMap.keys(), ...priorMap.keys()]);
  const employees: EmployeeVariance[] = [];
  for (const empId of allIds) {
    const c = curMap.get(empId);
    const p = priorMap.get(empId);
    const ref = c ?? p!;

    let status: EmployeeVariance['status'];
    let baseSeverity: VarianceSeverity;
    if (!p) { status = 'new'; baseSeverity = 'new'; }
    else if (!c) { status = 'removed'; baseSeverity = 'removed'; }
    else {
      const noChange = Number(c.gross_pay) === Number(p.gross_pay)
        && Number(c.paye) === Number(p.paye)
        && Number(c.net_pay) === Number(p.net_pay);
      status = noChange ? 'unchanged' : 'changed';
      baseSeverity = 'low';
    }

    const grossPay = diffTotals(Number(c?.gross_pay ?? 0), Number(p?.gross_pay ?? 0));
    const paye     = diffTotals(Number(c?.paye     ?? 0), Number(p?.paye     ?? 0));
    const netPay   = diffTotals(Number(c?.net_pay  ?? 0), Number(p?.net_pay  ?? 0));

    const severity = status === 'unchanged'
      ? 'low'
      : maxSeverity(baseSeverity, severityFromPct(grossPay.pct), severityFromPct(paye.pct), severityFromPct(netPay.pct));

    employees.push({
      employeeId: empId,
      employeeNumber: String(ref.employee_number),
      employeeName: `${ref.first_name} ${ref.last_name}`.trim(),
      status,
      severity,
      grossPay, paye, netPay,
    });
  }

  // Sort: highest-severity first, then by name
  const sevOrder: Record<VarianceSeverity, number> = { removed: 0, new: 1, high: 2, medium: 3, low: 4 };
  employees.sort((a, b) => {
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    return a.employeeName.localeCompare(b.employeeName);
  });

  return {
    runId,
    priorRunId: prior ? String(prior.id) : null,
    currentPeriod: { month: curMonth, year: curYear },
    priorPeriod: prior
      ? { month: Number(prior.period_month), year: Number(prior.period_year) }
      : null,
    totals,
    employees,
  };
}
