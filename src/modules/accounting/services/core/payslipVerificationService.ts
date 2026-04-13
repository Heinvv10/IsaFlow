/**
 * Payslip/IRP5 Cross-Verification Service
 * Pure business logic — no database dependencies.
 */

import type { ValidationDiscrepancy } from '@/modules/accounting/types/documentCapture.types';

export interface ExtractedPayslip {
  employeeName: string | null;
  idNumber: string | null;
  taxNumber: string | null;
  employerName: string | null;
  employerPayeRef: string | null;
  period: string | null;
  grossPay: number | null;
  netPay: number | null;
  paye: number | null;
  uif: number | null;
  sdl: number | null;
  pensionContrib: number | null;
  medicalAid: number | null;
  overtime: number | null;
  bonus: number | null;
  confidence: number;
}

export interface PayrollRecord {
  employeeId: string;
  employeeName: string;
  idNumber: string;
  grossPay: number;
  netPay: number;
  paye: number;
  uif: number;
  sdl: number;
  pension: number;
  medical: number;
}

export interface PayslipVerificationResult {
  valid: boolean;
  score: number;
  discrepancies: ValidationDiscrepancy[];
  verifiedAt: string;
}

export interface EmployeeMatch {
  employeeId: string;
  employeeName: string;
  confidence: number;
  matchMethod: 'id_number' | 'name';
}

export function parsePayslipExtractionResponse(response: string): ExtractedPayslip | null {
  let jsonStr = response.trim();
  if (jsonStr.includes('<think>')) jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const match = jsonStr.match(/\{[\s\S]*\}/);
  if (match) jsonStr = match[0];

  try {
    const p = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      employeeName: typeof p.employeeName === 'string' ? p.employeeName : null,
      idNumber: typeof p.idNumber === 'string' ? p.idNumber : null,
      taxNumber: typeof p.taxNumber === 'string' ? p.taxNumber : null,
      employerName: typeof p.employerName === 'string' ? p.employerName : null,
      employerPayeRef: typeof p.employerPayeRef === 'string' ? p.employerPayeRef : null,
      period: typeof p.period === 'string' ? p.period : null,
      grossPay: typeof p.grossPay === 'number' ? p.grossPay : null,
      netPay: typeof p.netPay === 'number' ? p.netPay : null,
      paye: typeof p.paye === 'number' ? p.paye : null,
      uif: typeof p.uif === 'number' ? p.uif : null,
      sdl: typeof p.sdl === 'number' ? p.sdl : null,
      pensionContrib: typeof p.pensionContrib === 'number' ? p.pensionContrib : null,
      medicalAid: typeof p.medicalAid === 'number' ? p.medicalAid : null,
      overtime: typeof p.overtime === 'number' ? p.overtime : null,
      bonus: typeof p.bonus === 'number' ? p.bonus : null,
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

export function matchEmployeeFromExtraction(
  payslip: ExtractedPayslip,
  employees: Array<{ id: string; name: string; idNumber: string }>,
): EmployeeMatch | null {
  // Prefer ID number match
  if (payslip.idNumber) {
    const match = employees.find(e => e.idNumber === payslip.idNumber);
    if (match) return { employeeId: match.id, employeeName: match.name, confidence: 1.0, matchMethod: 'id_number' };
  }

  // Fall back to name match
  if (payslip.employeeName) {
    const normPayslip = payslip.employeeName.toLowerCase().trim();
    const match = employees.find(e => e.name.toLowerCase().trim() === normPayslip);
    if (match) return { employeeId: match.id, employeeName: match.name, confidence: 0.85, matchMethod: 'name' };

    // Partial match
    const partial = employees.find(e =>
      normPayslip.includes(e.name.toLowerCase().trim()) || e.name.toLowerCase().trim().includes(normPayslip)
    );
    if (partial) return { employeeId: partial.id, employeeName: partial.name, confidence: 0.7, matchMethod: 'name' };
  }

  return null;
}

export function verifyPayslipAgainstPayroll(
  payslip: ExtractedPayslip,
  payroll: PayrollRecord,
): PayslipVerificationResult {
  const discrepancies: ValidationDiscrepancy[] = [];
  const tolerance = 1.01; // R1 rounding tolerance

  const checks: Array<{ field: string; extracted: number | null; expected: number; severity: 'error' | 'warning' }> = [
    { field: 'grossPay', extracted: payslip.grossPay, expected: payroll.grossPay, severity: 'error' },
    { field: 'netPay', extracted: payslip.netPay, expected: payroll.netPay, severity: 'error' },
    { field: 'paye', extracted: payslip.paye, expected: payroll.paye, severity: 'error' },
    { field: 'uif', extracted: payslip.uif, expected: payroll.uif, severity: 'warning' },
    { field: 'sdl', extracted: payslip.sdl, expected: payroll.sdl, severity: 'warning' },
  ];

  let matched = 0;
  let checked = 0;

  for (const check of checks) {
    if (check.extracted === null) continue;
    checked++;

    const diff = Math.abs(check.extracted - check.expected);
    if (diff > tolerance) {
      discrepancies.push({
        field: check.field,
        expected: check.expected,
        actual: check.extracted,
        severity: check.severity,
        message: `${check.field} mismatch: payslip shows ${check.extracted}, payroll has ${check.expected}`,
      });
    } else {
      matched++;
    }
  }

  const hasErrors = discrepancies.some(d => d.severity === 'error');
  const score = checked > 0 ? Math.round((matched / checked) * 100) / 100 : 0;

  return {
    valid: !hasErrors,
    score,
    discrepancies,
    verifiedAt: new Date().toISOString(),
  };
}

export function validatePayslipExtraction(payslip: ExtractedPayslip): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (payslip.grossPay === null) errors.push('grossPay is required');
  if (!payslip.employeeName && !payslip.idNumber) errors.push('employeeName or idNumber is required');

  return { valid: errors.length === 0, errors };
}
