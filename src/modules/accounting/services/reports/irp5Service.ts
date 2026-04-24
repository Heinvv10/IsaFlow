/**
 * IRP5/IT3(a) Certificate Generation Service
 * Certificate building + EMP501 reconciliation. Source codes are looked up
 * via sarsCodesService (DB-backed, year-effective) — no longer pure logic.
 */
import { getSarsCode, categoryToComponentType } from '@/modules/accounting/services/payroll/sarsCodesService';

export interface IRP5EmployeeData {
  grossSalary: number;
  commission: number;
  overtime: number;
  bonus: number;
  travelAllowance: number;
  pensionContribEmployee: number;
  medicalAidEmployee: number;
  retirementAnnuity: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
}

export interface SourceCodeEntry {
  code: string;
  description: string;
  amount: number;
}

export interface IRP5Certificate {
  employeeName: string;
  idNumber: string;
  taxNumber: string;
  employerName: string;
  employerPayeRef: string;
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  sourceCodes: SourceCodeEntry[];
  totalGrossIncome: number;
  totalDeductions: number;
  netRemuneration: number;
}

export interface EMP501MonthlyData {
  month: number;
  paye: number;
  uif: number;
  sdl: number;
  totalEmployees: number;
}

export interface EMP501Summary {
  taxYear: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalLiability: number;
  monthlyData: EMP501MonthlyData[];
  totalEmployees: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE CODE MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const CODE_MAPPING: Array<{ code: string; field: keyof IRP5EmployeeData }> = [
  { code: '3601', field: 'grossSalary' },
  { code: '3701', field: 'commission' },
  { code: '3801', field: 'overtime' },
  { code: '3605', field: 'bonus' },
  { code: '3702', field: 'travelAllowance' },
  { code: '4001', field: 'pensionContribEmployee' },
  { code: '4003', field: 'medicalAidEmployee' },
  { code: '4004', field: 'retirementAnnuity' },
  { code: '4102', field: 'paye' },
  { code: '4141', field: 'uifEmployee' },
  { code: '4142', field: 'uifEmployer' },
  { code: '4150', field: 'sdl' },
];

export async function calculateIRP5SourceCodes(
  data: IRP5EmployeeData,
  taxYear: number
): Promise<SourceCodeEntry[]> {
  const entries: SourceCodeEntry[] = [];
  for (const mapping of CODE_MAPPING) {
    const amount = data[mapping.field];
    if (amount && amount > 0) {
      const sarsCode = await getSarsCode(mapping.code, taxYear);
      entries.push({
        code: mapping.code,
        description: sarsCode?.description ?? '',
        amount: Math.round(amount * 100) / 100,
      });
    }
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// IRP5 CERTIFICATE
// ═══════════════════════════════════════════════════════════════════════════

export async function buildIRP5Certificate(input: {
  employeeData: IRP5EmployeeData;
  employeeName: string;
  idNumber: string;
  taxNumber: string;
  employerName: string;
  employerPayeRef: string;
  taxYear: number;
  periodStart: string;
  periodEnd: string;
}): Promise<IRP5Certificate> {
  const sourceCodes = await calculateIRP5SourceCodes(input.employeeData, input.taxYear);

  const codeCategories = await Promise.all(
    sourceCodes.map(async (sc) => {
      const def = await getSarsCode(sc.code, input.taxYear);
      return { sc, coarse: def ? categoryToComponentType(def.category) : null };
    })
  );
  const incomeCodes = codeCategories.filter((x) => x.coarse === 'income').map((x) => x.sc);
  const deductionCodes = codeCategories.filter((x) => x.coarse === 'deduction').map((x) => x.sc);

  const totalGrossIncome = Math.round(incomeCodes.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  const totalDeductions = Math.round(deductionCodes.reduce((s, c) => s + c.amount, 0) * 100) / 100;

  return {
    employeeName: input.employeeName,
    idNumber: input.idNumber,
    taxNumber: input.taxNumber,
    employerName: input.employerName,
    employerPayeRef: input.employerPayeRef,
    taxYear: input.taxYear,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    sourceCodes,
    totalGrossIncome,
    totalDeductions,
    netRemuneration: Math.round((totalGrossIncome - totalDeductions) * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EMP501 SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

export function buildEMP501Summary(monthlyData: EMP501MonthlyData[], taxYear: number): EMP501Summary {
  const totalPaye = Math.round(monthlyData.reduce((s, m) => s + m.paye, 0) * 100) / 100;
  const totalUif = Math.round(monthlyData.reduce((s, m) => s + m.uif, 0) * 100) / 100;
  const totalSdl = Math.round(monthlyData.reduce((s, m) => s + m.sdl, 0) * 100) / 100;
  const maxEmployees = monthlyData.length > 0 ? Math.max(...monthlyData.map(m => m.totalEmployees)) : 0;

  return {
    taxYear,
    totalPaye,
    totalUif,
    totalSdl,
    totalLiability: Math.round((totalPaye + totalUif + totalSdl) * 100) / 100,
    monthlyData,
    totalEmployees: maxEmployees,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validateIRP5Data(input: {
  employeeName: string;
  idNumber: string;
  taxNumber: string;
  grossSalary: number;
  paye: number;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.employeeName || input.employeeName.trim() === '') errors.push('Employee name is required');
  if (!input.idNumber || input.idNumber.length !== 13 || !/^\d{13}$/.test(input.idNumber)) errors.push('Valid 13-digit SA ID number is required');
  if (input.grossSalary < 0) errors.push('Gross salary cannot be negative');
  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export function formatSARSAmount(amount: number): string {
  return String(Math.round(amount * 100));
}
