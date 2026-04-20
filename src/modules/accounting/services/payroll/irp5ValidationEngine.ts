/**
 * IRP5 Validation Engine — pure TS rules for SARS source-code compliance.
 *
 * Consumers (e.g. /api/payroll/irp5/summary) assemble inputs from the DB
 * and call these functions. No DB access here — keeps rules easy to test
 * and deterministic.
 */

import { SARS_SOURCE_CODES } from '@/modules/accounting/services/reports/irp5Service';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationMessage {
  severity: ValidationSeverity;
  code: string;            // stable rule id, e.g. 'IRP5_UNKNOWN_CODE'
  message: string;         // plain-English text shown in the UI
  field?: string;          // optional deep-link hint (e.g. 'tax_number')
}

export interface ComponentConfig {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
  isActive: boolean;
}

export interface EmployeeIrp5Input {
  taxNumber: string | null;
  idNumber: string | null;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  /** SARS source codes used by this employee's active components, from payroll_components.sars_source_code */
  componentCodes: string[];
  /** True when an approved severance tax directive exists for this employee in the current tax year. */
  hasApprovedSeveranceDirective?: boolean;
}

// Category → component_type expected pairing.
const COMPONENT_TYPE_TO_CATEGORY: Record<ComponentConfig['componentType'], 'income' | 'deduction' | 'employer'> = {
  earning: 'income',
  deduction: 'deduction',
  employer_contribution: 'employer',
};

// Known income codes — used to check "PAYE without any income code".
const INCOME_CODES = Object.entries(SARS_SOURCE_CODES)
  .filter(([, v]) => v.category === 'income')
  .map(([code]) => code);

/**
 * SA SARS tax reference number: 10 digits, starts with 0/1/2/3/9.
 * https://www.sars.gov.za — income tax reference format.
 */
export function isValidSarsTaxNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[01239]\d{9}$/.test(value.trim());
}

export function isValidSaIdNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{13}$/.test(value.trim());
}

export function isKnownSarsCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SARS_SOURCE_CODES, code);
}

/**
 * Validate a single payroll_components row's SARS code + category alignment.
 */
export function validateComponent(component: ComponentConfig): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];
  const code = component.sarsSourceCode.trim();

  if (!isKnownSarsCode(code)) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_UNKNOWN_CODE',
      message: `Component "${component.name}" uses unknown SARS source code ${code}`,
      field: `payroll_components.${component.id}.sars_source_code`,
    });
    return msgs; // can't evaluate category without a known code
  }

  const expectedCategory = COMPONENT_TYPE_TO_CATEGORY[component.componentType];
  const actualCategory = SARS_SOURCE_CODES[code]?.category;
  if (actualCategory && actualCategory !== expectedCategory) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_CATEGORY_MISMATCH',
      message: `Component "${component.name}" is a ${component.componentType} but code ${code} is categorised as ${actualCategory}`,
      field: `payroll_components.${component.id}.sars_source_code`,
    });
  }
  return msgs;
}

/**
 * Validate the full list of company components. Catches duplicate codes
 * configured across multiple active components (a common reconciliation
 * trap — two earnings rolling up to the same IRP5 line).
 */
export function validateCompanyComponents(components: ComponentConfig[]): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  for (const c of components) {
    if (!c.isActive) continue;
    msgs.push(...validateComponent(c));
  }

  const codeCounts = new Map<string, string[]>();
  for (const c of components) {
    if (!c.isActive) continue;
    const list = codeCounts.get(c.sarsSourceCode) ?? [];
    list.push(c.name);
    codeCounts.set(c.sarsSourceCode, list);
  }
  for (const [code, names] of codeCounts) {
    if (names.length > 1) {
      msgs.push({
        severity: 'warning',
        code: 'IRP5_DUPLICATE_CODE_ACROSS_COMPONENTS',
        message: `SARS code ${code} is used by multiple active components: ${names.join(', ')}`,
      });
    }
  }

  return msgs;
}

/**
 * Per-employee IRP5 readiness rules. Returns one message per issue.
 */
export function validateEmployeeIrp5(input: EmployeeIrp5Input): ValidationMessage[] {
  const msgs: ValidationMessage[] = [];

  if (!input.taxNumber) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_MISSING_TAX_NUMBER',
      message: 'Missing tax number',
      field: 'tax_number',
    });
  } else if (!isValidSarsTaxNumber(input.taxNumber)) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_INVALID_TAX_NUMBER',
      message: 'Tax number must be 10 digits starting with 0, 1, 2, 3 or 9',
      field: 'tax_number',
    });
  }

  if (!input.idNumber) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_MISSING_ID',
      message: 'Missing ID/passport number',
      field: 'id_number',
    });
  } else if (!isValidSaIdNumber(input.idNumber)) {
    // Foreign nationals have passports, which are shorter — treat as warning.
    msgs.push({
      severity: 'warning',
      code: 'IRP5_INVALID_ID',
      message: 'ID number is not a 13-digit SA ID (passport holders can ignore)',
      field: 'id_number',
    });
  }

  if (input.totalGross === 0) {
    msgs.push({
      severity: 'info',
      code: 'IRP5_NO_PAYROLL',
      message: 'No payroll runs in this tax year',
    });
    return msgs; // downstream rules don't apply without payroll
  }

  // Unknown codes in the employee's component set
  const unknown = input.componentCodes.filter((c) => !isKnownSarsCode(c));
  for (const c of unknown) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_UNKNOWN_CODE',
      message: `Employee uses unknown SARS source code ${c}`,
    });
  }

  // PAYE present but no income code used
  if (input.totalPaye > 0) {
    const hasIncomeCode = input.componentCodes.some((c) => INCOME_CODES.includes(c));
    if (!hasIncomeCode) {
      msgs.push({
        severity: 'error',
        code: 'IRP5_PAYE_WITHOUT_INCOME_CODE',
        message: 'PAYE deducted but no income source code configured — IRP5 certificate will be invalid',
      });
    }
  }

  // Note: we deliberately do NOT check for component codes 4141 (UIF) or 4150 (SDL)
  // on the employee. In this codebase UIF and SDL are auto-calculated from gross pay
  // by uifEngine / sdlEngine and landed on IRP5 via run-line aggregation — they are
  // never payroll_components. An earlier version of this engine flagged their
  // "absence" as a warning, which fired for every correctly-configured employee.

  // Severance lump sum without an approved tax directive — payslip will over/under-tax
  // because the normal PAYE engine is applied instead of the directive rate.
  if (input.componentCodes.includes('3901') && input.hasApprovedSeveranceDirective !== true) {
    msgs.push({
      severity: 'warning',
      code: 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE',
      message: 'Severance (code 3901) is present but no approved SARS tax directive is on file — PAYE will be calculated at the normal monthly rate, not the directive rate. Apply for a directive before submission.',
    });
  }

  // Duplicate codes within the same employee's component list
  const seen = new Map<string, number>();
  for (const c of input.componentCodes) {
    seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  for (const [code, count] of seen) {
    if (count > 1) {
      msgs.push({
        severity: 'warning',
        code: 'IRP5_DUPLICATE_CODE_ON_EMPLOYEE',
        message: `SARS code ${code} is used by ${count} active components on this employee`,
      });
    }
  }

  return msgs;
}

/** Convenience — top severity across a list of messages. */
export function highestSeverity(msgs: ValidationMessage[]): ValidationSeverity | null {
  if (msgs.some((m) => m.severity === 'error')) return 'error';
  if (msgs.some((m) => m.severity === 'warning')) return 'warning';
  if (msgs.length > 0) return 'info';
  return null;
}
