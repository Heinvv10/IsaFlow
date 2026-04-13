/**
 * IRP5/IT3(a) Certificate Generation Service
 * SARS source codes, certificate building, EMP501 reconciliation.
 * Pure business logic — no database dependencies.
 */

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
// SARS SOURCE CODES
// ═══════════════════════════════════════════════════════════════════════════

export const SARS_SOURCE_CODES: Record<string, { description: string; category: 'income' | 'deduction' | 'employer' }> = {
  '3601': { description: 'Gross salary/wages', category: 'income' },
  '3605': { description: 'Annual bonus', category: 'income' },
  '3701': { description: 'Commission', category: 'income' },
  '3702': { description: 'Travel allowance', category: 'income' },
  '3703': { description: 'Reimbursive travel allowance', category: 'income' },
  '3713': { description: 'Other allowances', category: 'income' },
  '3801': { description: 'Overtime payments', category: 'income' },
  '3802': { description: 'Lump sum payments', category: 'income' },
  '3810': { description: 'Leave pay', category: 'income' },
  '3815': { description: 'Restraint of trade', category: 'income' },
  '4001': { description: 'Pension fund contributions (employee)', category: 'deduction' },
  '4002': { description: 'Provident fund contributions (employee)', category: 'deduction' },
  '4003': { description: 'Medical aid contributions (employee)', category: 'deduction' },
  '4004': { description: 'Retirement annuity contributions', category: 'deduction' },
  '4005': { description: 'Donations (Section 18A)', category: 'deduction' },
  '4102': { description: 'PAYE (Pay As You Earn)', category: 'deduction' },
  '4141': { description: 'UIF contributions (employee)', category: 'deduction' },
  '4142': { description: 'UIF contributions (employer)', category: 'employer' },
  '4150': { description: 'SDL (Skills Development Levy)', category: 'employer' },
};

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

export function calculateIRP5SourceCodes(data: IRP5EmployeeData): SourceCodeEntry[] {
  const entries: SourceCodeEntry[] = [];
  for (const mapping of CODE_MAPPING) {
    const amount = data[mapping.field];
    if (amount && amount > 0) {
      entries.push({
        code: mapping.code,
        description: SARS_SOURCE_CODES[mapping.code]?.description || '',
        amount: Math.round(amount * 100) / 100,
      });
    }
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// IRP5 CERTIFICATE
// ═══════════════════════════════════════════════════════════════════════════

export function buildIRP5Certificate(input: {
  employeeData: IRP5EmployeeData;
  employeeName: string;
  idNumber: string;
  taxNumber: string;
  employerName: string;
  employerPayeRef: string;
  taxYear: number;
  periodStart: string;
  periodEnd: string;
}): IRP5Certificate {
  const sourceCodes = calculateIRP5SourceCodes(input.employeeData);

  const incomeCodes = sourceCodes.filter(sc => {
    const def = SARS_SOURCE_CODES[sc.code];
    return def?.category === 'income';
  });
  const deductionCodes = sourceCodes.filter(sc => {
    const def = SARS_SOURCE_CODES[sc.code];
    return def?.category === 'deduction';
  });

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
