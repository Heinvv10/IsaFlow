/**
 * SARS e-Filing Service — Payload builders, validation, compliance calendar
 * Covers: VAT201, EMP201, EMP501, IRP6 (provisional), IT14
 * Pure business logic — no database dependencies.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface VAT201Data {
  taxPeriod: string;
  vatNumber: string;
  companyName: string;
  outputVATStandard: number;
  outputVATZeroRated: number;
  outputVATExempt: number;
  inputVATCapitalGoods: number;
  inputVATOther: number;
  adjustments: number;
}

export interface EMP201Data {
  taxPeriod: string;
  payeReference: string;
  companyName: string;
  totalPAYE: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
}

export interface IRP6Data {
  taxYear: number;
  period: 1 | 2;
  taxableIncome: number;
  taxCredits: number;
  previousPayments: number;
  companyName: string;
  taxNumber: string;
}

export interface ComplianceDeadline {
  taxType: string;
  dueDate: string;
  description: string;
  period: string;
}

export interface SARSPayload {
  taxType: string;
  taxPeriod?: string;
  taxYear?: number;
  fields: Array<{ code: string; label: string; value: string | number }>;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// TAX TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const SARS_TAX_TYPES = {
  VAT201: { name: 'VAT Return', frequency: 'monthly', description: 'Monthly/bi-monthly VAT return' },
  EMP201: { name: 'Monthly Employer Declaration', frequency: 'monthly', description: 'PAYE, UIF, SDL monthly declaration' },
  EMP501: { name: 'Employer Reconciliation', frequency: 'bi-annual', description: 'Bi-annual employer tax reconciliation' },
  IRP6: { name: 'Provisional Tax', frequency: 'bi-annual', description: 'Provisional tax payment (1st & 2nd)' },
  IT14: { name: 'Company Income Tax', frequency: 'annual', description: 'Annual company income tax return' },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export function formatSARSDate(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

export function formatSARSCurrency(amount: number): string {
  return String(Math.round(amount * 100));
}

// ═══════════════════════════════════════════════════════════════════════════
// VAT201 PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

export function buildVAT201Payload(data: VAT201Data): SARSPayload & {
  totalOutputVAT: number; totalInputVAT: number; netVAT: number;
} {
  const totalOutputVAT = Math.round((data.outputVATStandard + data.outputVATZeroRated + data.outputVATExempt) * 100) / 100;
  const totalInputVAT = Math.round((data.inputVATCapitalGoods + data.inputVATOther) * 100) / 100;
  const netVAT = Math.round((totalOutputVAT - totalInputVAT + data.adjustments) * 100) / 100;

  return {
    taxType: 'VAT201',
    taxPeriod: data.taxPeriod,
    vatNumber: data.vatNumber,
    companyName: data.companyName,
    totalOutputVAT,
    totalInputVAT,
    netVAT,
    fields: [
      { code: 'F01', label: 'Output VAT - Standard Rate (15%)', value: data.outputVATStandard },
      { code: 'F02', label: 'Output VAT - Zero Rated', value: data.outputVATZeroRated },
      { code: 'F03', label: 'Output VAT - Exempt', value: data.outputVATExempt },
      { code: 'F10', label: 'Input VAT - Capital Goods', value: data.inputVATCapitalGoods },
      { code: 'F11', label: 'Input VAT - Other', value: data.inputVATOther },
      { code: 'F13', label: 'Adjustments', value: data.adjustments },
      { code: 'F14', label: 'Total Output VAT', value: totalOutputVAT },
      { code: 'F15', label: 'Total Input VAT', value: totalInputVAT },
      { code: 'F16', label: 'Net VAT', value: netVAT },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EMP201 PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

export function buildEMP201Payload(data: EMP201Data): SARSPayload & {
  paye: number; uif: number; sdl: number; totalLiability: number; payeReference: string;
} {
  const totalLiability = Math.round((data.totalPAYE + data.totalUIF + data.totalSDL) * 100) / 100;

  return {
    taxType: 'EMP201',
    taxPeriod: data.taxPeriod,
    payeReference: data.payeReference,
    companyName: data.companyName,
    paye: data.totalPAYE,
    uif: data.totalUIF,
    sdl: data.totalSDL,
    totalLiability,
    employeeCount: data.employeeCount,
    fields: [
      { code: 'PAYE', label: 'Pay As You Earn', value: data.totalPAYE },
      { code: 'UIF', label: 'Unemployment Insurance Fund', value: data.totalUIF },
      { code: 'SDL', label: 'Skills Development Levy', value: data.totalSDL },
      { code: 'TOTAL', label: 'Total Liability', value: totalLiability },
      { code: 'EMP_COUNT', label: 'Number of Employees', value: data.employeeCount },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// IRP6 (PROVISIONAL TAX) PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

function calculateEstimatedTax(taxableIncome: number): number {
  // SA company tax rate: 27% (2024/2025 onwards)
  const COMPANY_TAX_RATE = 0.27;
  return Math.round(taxableIncome * COMPANY_TAX_RATE * 100) / 100;
}

export function buildIRP6Payload(data: IRP6Data): SARSPayload & {
  estimatedTax: number; amountDue: number; period: number; taxYear: number;
} {
  const annualTax = calculateEstimatedTax(data.taxableIncome);
  // 1st provisional = ~50% of estimated annual tax, 2nd = remainder
  const estimatedTax = data.period === 1
    ? Math.round(annualTax * 0.5 * 100) / 100
    : Math.round(annualTax * 100) / 100;

  const amountDue = Math.round((estimatedTax - data.taxCredits - data.previousPayments) * 100) / 100;

  return {
    taxType: 'IRP6',
    taxYear: data.taxYear,
    period: data.period,
    companyName: data.companyName,
    taxNumber: data.taxNumber,
    estimatedTax,
    amountDue,
    fields: [
      { code: 'TAXABLE_INCOME', label: 'Estimated Taxable Income', value: data.taxableIncome },
      { code: 'EST_TAX', label: 'Estimated Tax', value: estimatedTax },
      { code: 'CREDITS', label: 'Tax Credits', value: data.taxCredits },
      { code: 'PREV_PAYMENTS', label: 'Previous Payments', value: data.previousPayments },
      { code: 'AMOUNT_DUE', label: 'Amount Due', value: amountDue },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validateSARSSubmission(input: {
  taxType: string;
  taxPeriod: string;
  vatNumber?: string;
  payeReference?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!input.taxType || input.taxType.trim() === '') errors.push('Tax type is required');
  if (!input.taxPeriod || input.taxPeriod.trim() === '') errors.push('Tax period is required');

  if (input.taxType === 'VAT201' && input.vatNumber) {
    if (!/^4\d{9}$/.test(input.vatNumber)) errors.push('VAT number must be 10 digits starting with 4');
  }

  return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLIANCE CALENDAR
// ═══════════════════════════════════════════════════════════════════════════

export function calculateComplianceDeadlines(year: number): ComplianceDeadline[] {
  const deadlines: ComplianceDeadline[] = [];

  // EMP201 — monthly, due by 7th of following month
  for (let m = 1; m <= 12; m++) {
    const dueMonth = m === 12 ? 1 : m + 1;
    const dueYear = m === 12 ? year + 1 : year;
    deadlines.push({
      taxType: 'EMP201',
      dueDate: `${dueYear}-${String(dueMonth).padStart(2, '0')}-07`,
      description: `EMP201 for ${year}-${String(m).padStart(2, '0')}`,
      period: `${year}-${String(m).padStart(2, '0')}`,
    });
  }

  // VAT201 — monthly, due by 25th of following month (Category A)
  for (let m = 1; m <= 12; m++) {
    const dueMonth = m === 12 ? 1 : m + 1;
    const dueYear = m === 12 ? year + 1 : year;
    deadlines.push({
      taxType: 'VAT201',
      dueDate: `${dueYear}-${String(dueMonth).padStart(2, '0')}-25`,
      description: `VAT201 for ${year}-${String(m).padStart(2, '0')}`,
      period: `${year}-${String(m).padStart(2, '0')}`,
    });
  }

  // EMP501 — interim (October) and annual (May)
  deadlines.push({
    taxType: 'EMP501',
    dueDate: `${year}-10-31`,
    description: `EMP501 Interim Reconciliation (Mar-Aug ${year})`,
    period: `${year}-H1`,
  });
  deadlines.push({
    taxType: 'EMP501',
    dueDate: `${year + 1}-05-31`,
    description: `EMP501 Annual Reconciliation (Mar ${year}-Feb ${year + 1})`,
    period: `${year}-H2`,
  });

  // IRP6 — 1st provisional (end of August), 2nd provisional (end of February)
  deadlines.push({
    taxType: 'IRP6',
    dueDate: `${year}-08-31`,
    description: `1st Provisional Tax Payment (${year})`,
    period: `${year}-P1`,
  });
  deadlines.push({
    taxType: 'IRP6',
    dueDate: `${year + 1}-02-28`,
    description: `2nd Provisional Tax Payment (${year})`,
    period: `${year}-P2`,
  });

  return deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
