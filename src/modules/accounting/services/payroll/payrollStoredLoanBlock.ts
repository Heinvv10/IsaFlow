/**
 * A stored run line's loan shortfall, read from a row the caller already holds, so the cash register
 * and the parallel-run export can check the very snapshot they emit. Mirrors findOverdrawnLines
 * (payrollRunLines): a line coded LOAN_INSTALMENT_EXCEEDS_PAY or DEDUCTIONS_EXCEED_PAY is decided by
 * its code (its rawNet, else the rebuilt raw net); an uncoded line at nil predates the codes and is
 * rebuilt from its own component_breakdown. Only a loan shortfall is returned: loanInstalmentBlocker
 * ignores the rest, and an unreadable breakdown is left to the approval gate as it is there.
 *
 * The row needs: employee_id, employee_number, first_name, last_name, calculation_version, net_pay,
 * gross_pay, paye, uif_employee, component_breakdown, validation_results and (optionally) loans.
 */
import type { DbRow } from '@/lib/neon';
import type { OverdrawnLine } from './payrollRunLines';
import type { ValidationResult } from './payrollTypes';

const round2 = (value: number) => Math.round(value * 100) / 100;

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface BreakdownItem { amount?: unknown; isNonCash?: unknown; paidOutsidePayroll?: unknown; sarsSourceCode?: unknown }

/** The raw net with and without the LOAN-coded items, rebuilt as findOverdrawnLines does; null if unreadable. */
function rebuiltRawNet(r: DbRow): { rawNet: number; withoutLoan: number } | null {
  const breakdown = parseJson(r.component_breakdown);
  const gross = Number(r.gross_pay ?? 0);
  if (!Array.isArray(breakdown) || (breakdown.length === 0 && gross !== 0)) return null;
  let cashTotal = 0;
  let loan = 0;
  for (const item of breakdown as BreakdownItem[]) {
    const amount = Number(item?.amount);
    if (!Number.isFinite(amount)) continue;
    if (String(item.isNonCash) !== 'true' && String(item.paidOutsidePayroll) !== 'true') cashTotal += amount;
    if (typeof item.sarsSourceCode === 'string' && item.sarsSourceCode.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') === 'LOAN') loan += amount;
  }
  const base = gross - Number(r.paye ?? 0) - Number(r.uif_employee ?? 0) - (cashTotal - gross);
  return { rawNet: round2(base), withoutLoan: round2(base + loan) };
}

export function loanOverdrawnFromStoredRow(r: DbRow): OverdrawnLine[] {
  if (r.employee_id == null) return [];
  const parsed = parseJson(r.validation_results);
  const validations = Array.isArray(parsed) ? parsed as ValidationResult[] : [];
  const flagged = validations.find((v) => v.code === 'LOAN_INSTALMENT_EXCEEDS_PAY')
    ?? validations.find((v) => v.code === 'DEDUCTIONS_EXCEED_PAY');
  if (flagged && flagged.code !== 'LOAN_INSTALMENT_EXCEEDS_PAY') return [];
  if (!flagged && Number(r.net_pay) !== 0) return [];
  const rebuilt = typeof flagged?.rawNet === 'number' ? null : rebuiltRawNet(r);
  const rawNet = typeof flagged?.rawNet === 'number' ? flagged.rawNet : rebuilt?.rawNet;
  if (rawNet == null || !Number.isFinite(rawNet) || rawNet >= 0) return [];
  if (!flagged && !(rebuilt && rebuilt.withoutLoan >= 0)) return [];
  return [{
    employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number),
    employeeName: `${String(r.first_name)} ${String(r.last_name)}`.trim(),
    shortfall: -rawNet,
    fromLoan: true,
    calculationVersion: r.calculation_version == null ? null : Number(r.calculation_version),
    loans: flagged?.loans ?? (Array.isArray(r.loans) ? r.loans.map(String) : []),
  }];
}
