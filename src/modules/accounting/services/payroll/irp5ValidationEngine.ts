/**
 * IRP5 Validation Engine — year-aware SARS source-code compliance rules.
 *
 * Looks up codes via sarsCodesService (DB-backed, year-effective). All
 * functions take an explicit taxYear so historical IRP5 regeneration
 * uses the codes valid at the time, not today's set.
 */

import { medicalFieldRules } from './easyFileMedicalFields';
import {
  getSarsCode,
  isKnownSarsCode,
  listSarsCodes,
  categoryToComponentType,
} from '@/modules/accounting/services/payroll/sarsCodesService';

import { PAYE_4115_CODES } from './payrollLumpSumFiling';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationMessage {
  severity: ValidationSeverity;
  code: string;
  message: string;
  field?: string;
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
  componentCodes: string[];
  hasApprovedSeveranceDirective?: boolean;
}

const COMPONENT_TYPE_TO_CATEGORY: Record<ComponentConfig['componentType'], 'income' | 'deduction' | 'employer'> = {
  earning: 'income',
  deduction: 'deduction',
  employer_contribution: 'employer',
};

export function isValidSarsTaxNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[01239]\d{9}$/.test(value.trim());
}

export function isValidSaIdNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{13}$/.test(value.trim());
}

export async function validateComponent(
  component: ComponentConfig,
  taxYear: number
): Promise<ValidationMessage[]> {
  const msgs: ValidationMessage[] = [];
  const code = component.sarsSourceCode.trim();

  const sarsCode = await getSarsCode(code, taxYear);
  if (!sarsCode) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_UNKNOWN_CODE',
      message: `Component "${component.name}" uses unknown SARS source code ${code} for tax year ${taxYear}`,
      field: `payroll_components.${component.id}.sars_source_code`,
    });
    return msgs;
  }

  if (sarsCode.status === 'deprecated') {
    msgs.push({
      severity: 'error',
      code: 'IRP5_DEPRECATED_CODE',
      message: `Component "${component.name}" uses deprecated SARS source code ${code} for tax year ${taxYear}`,
      field: `payroll_components.${component.id}.sars_source_code`,
    });
  }

  const expectedCategory = COMPONENT_TYPE_TO_CATEGORY[component.componentType];
  const actualCoarse = categoryToComponentType(sarsCode.category);
  if (actualCoarse !== expectedCategory) {
    msgs.push({
      severity: 'error',
      code: 'IRP5_CATEGORY_MISMATCH',
      message: `Component "${component.name}" is a ${component.componentType} but code ${code} is categorised as ${sarsCode.category}`,
      field: `payroll_components.${component.id}.sars_source_code`,
    });
  }
  return msgs;
}

export async function validateCompanyComponents(
  components: ComponentConfig[],
  taxYear: number
): Promise<ValidationMessage[]> {
  const msgs: ValidationMessage[] = [];

  for (const c of components) {
    if (!c.isActive) continue;
    msgs.push(...(await validateComponent(c, taxYear)));
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

export async function validateEmployeeIrp5(
  input: EmployeeIrp5Input,
  taxYear: number
): Promise<ValidationMessage[]> {
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
    return msgs;
  }

  for (const c of input.componentCodes) {
    if (!(await isKnownSarsCode(c, taxYear))) {
      msgs.push({
        severity: 'error',
        code: 'IRP5_UNKNOWN_CODE',
        message: `Employee uses unknown SARS source code ${c} for tax year ${taxYear}`,
      });
    }
  }

  if (input.totalPaye > 0) {
    const incomeCodes = (await listSarsCodes(taxYear, { excludeDeprecated: true }))
      .filter((c) => categoryToComponentType(c.category) === 'income')
      .map((c) => c.code);
    const hasIncomeCode = input.componentCodes.some((c) => incomeCodes.includes(c));
    if (!hasIncomeCode) {
      msgs.push({
        severity: 'error',
        code: 'IRP5_PAYE_WITHOUT_INCOME_CODE',
        message: 'PAYE deducted but no income source code configured — IRP5 certificate will be invalid',
      });
    }
  }

  // UIF (4141) and SDL (4142) are auto-calculated from gross pay by uifEngine /
  // sdlEngine — they are never payroll_components, so we do NOT flag their
  // absence on the employee.

  if (input.componentCodes.includes('3901') && input.hasApprovedSeveranceDirective !== true) {
    msgs.push({
      severity: 'warning',
      code: 'IRP5_SEVERANCE_WITHOUT_DIRECTIVE',
      message: 'Severance (code 3901) is present but no approved SARS tax directive is on file — the pay run deducts no PAYE from a lump sum without one, and a run paying it cannot be approved. Apply for the directive.',
    });
  }

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


/**
 * The certificate-type and tax-field rules of one e@syFile employee record
 * (its `code,value` lines), per SARS BRS PAYE Employer Reconciliation V25.3.0
 * (Jun-26): p. 17 (3015) an IRP5 needs 4101, 4102 or 4115 above nil and no
 * 4150, an IT3(a) needs 4150 and none of 4101/4102/4115; p. 57 (4115) it is
 * mandatory beside 3901/3915/3920-3924; p. 58 (4150) only 2-10, and 04 needs
 * the directive information; p. 59-61 the medical rules (medicalFieldRules:
 * 4005/4116/4120, 4120 against the age, 08 only with a credit above nil).
 * buildIrp5File refuses a file that breaks them.
 */
export function validateCertificateTaxFields(lines: string[]): ValidationMessage[] {
  const field = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(',');
    if (i > 0 && !field.has(l.slice(0, i))) field.set(l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, ''));
  }
  const msgs: ValidationMessage[] = [];
  const err = (code: string, message: string) => msgs.push({ severity: 'error', code, message, field: code });
  const tax = ['4101', '4102', '4115'].filter(c => field.has(c));
  const reason = field.get('4150');
  medicalFieldRules(field, err);
  if (field.get('3015') === 'IT3(a)') {
    if (reason == null) err('IT3A_WITHOUT_REASON_CODE', 'An IT3(a) needs a reason code for non-deduction of tax (4150).');
    else if (!/^(0?[2-9]|10)$/.test(reason)) err('IT3A_INVALID_REASON_CODE', `Reason code 4150 must be 02 to 10, not ${reason}.`);
    if (tax.length > 0) err('IT3A_WITH_TAX_FIELD', `An IT3(a) must not carry ${tax.join(', ')}.`);
    if (reason != null && Number(reason) === 4 && !field.has('3230')) {
      err('REASON_04_WITHOUT_DIRECTIVE', 'Reason code 04 (nil directive) needs the directive information (3230-3233).');
    }
    return msgs;
  }
  if (!tax.some(c => Number(field.get(c)) > 0)) {
    err('IRP5_NO_TAX', 'An IRP5 needs 4101, 4102 or 4115 above nil; a certificate with no tax deducted is an IT3(a).');
  }
  if (reason != null) err('IRP5_WITH_REASON_CODE', 'An IRP5 must not carry a reason code (4150).');
  if ([...PAYE_4115_CODES].some(c => field.has(c)) && !field.has('4115')) {
    err('LUMP_SUM_WITHOUT_4115', 'A lump sum under 3901, 3915 or 3920-3924 needs its PAYE under 4115 (0.00 if nil).');
  }
  return msgs;
}

export function highestSeverity(msgs: ValidationMessage[]): ValidationSeverity | null {
  if (msgs.some((m) => m.severity === 'error')) return 'error';
  if (msgs.some((m) => m.severity === 'warning')) return 'warning';
  if (msgs.length > 0) return 'info';
  return null;
}
