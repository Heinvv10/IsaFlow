/**
 * SARS IRP5 Source Codes — 2025/2026 tax year.
 * https://www.sars.gov.za/types-of-tax/pay-as-you-earn/paye-reference-codes/
 *
 * Codes are grouped as income, deductions, or employer-side amounts.
 * Code-dependency rules below are enforced by payrollValidationService.
 */

export type SarsCodeType = 'income' | 'deduction' | 'employer';

export interface SarsCode {
  code: string;
  description: string;
  type: SarsCodeType;
  taxable: boolean;
}

export const SARS_CODES: Readonly<Record<string, SarsCode>> = Object.freeze({
  '3601': { code: '3601', description: 'Income — salary/wages',              type: 'income',     taxable: true },
  '3605': { code: '3605', description: 'Annual payment / bonus',             type: 'income',     taxable: true },
  '3606': { code: '3606', description: 'Commission',                         type: 'income',     taxable: true },
  '3615': { code: '3615', description: 'Director\'s fee',                    type: 'income',     taxable: true },
  '3701': { code: '3701', description: 'Travel allowance (full taxable)',    type: 'income',     taxable: true },
  '3702': { code: '3702', description: 'Reimbursive travel — non-taxable',   type: 'income',     taxable: false },
  '3713': { code: '3713', description: 'Travel allowance (80%/20% rule)',    type: 'income',     taxable: true },
  '3801': { code: '3801', description: 'Use of motor vehicle (fringe)',      type: 'income',     taxable: true },
  '3802': { code: '3802', description: 'Right of use of asset (housing)',    type: 'income',     taxable: true },
  '3810': { code: '3810', description: 'Medical aid — employer contribution',type: 'income',     taxable: true },
  '4001': { code: '4001', description: 'PAYE',                               type: 'deduction',  taxable: false },
  '4002': { code: '4002', description: 'UIF — employee contribution',        type: 'deduction',  taxable: false },
  '4005': { code: '4005', description: 'SDL',                                type: 'employer',   taxable: false },
  '4006': { code: '4006', description: 'Retirement fund — employee',         type: 'deduction',  taxable: false },
  '4474': { code: '4474', description: 'Medical aid — employee contribution',type: 'deduction',  taxable: false },
  '6004': { code: '6004', description: 'ETI offset against PAYE',            type: 'employer',   taxable: false },
});

export interface SarsCodeDependencyRule {
  code: string;
  requires: (ctx: SarsCodeContext) => { ok: true } | { ok: false; message: string };
}

export interface SarsCodeContext {
  codes: ReadonlyArray<string>;
  travelLogbookKept: boolean;
  travelTaxablePct: number;
  hasBasicSalary: boolean;
}

export const SARS_DEPENDENCY_RULES: ReadonlyArray<SarsCodeDependencyRule> = [
  {
    code: '3713',
    requires: (ctx) => {
      if (ctx.travelLogbookKept && ctx.travelTaxablePct !== 20) {
        return { ok: false, message: 'Travel code 3713 with logbook kept requires travel_taxable_pct = 20' };
      }
      if (!ctx.travelLogbookKept && ctx.travelTaxablePct !== 80) {
        return { ok: false, message: 'Travel code 3713 without logbook requires travel_taxable_pct = 80' };
      }
      return { ok: true };
    },
  },
  {
    code: '3605',
    requires: (ctx) => ctx.hasBasicSalary
      ? { ok: true }
      : { ok: false, message: 'Annual bonus (3605) requires basic salary (3601)' },
  },
  {
    code: '3606',
    requires: (ctx) => ctx.hasBasicSalary
      ? { ok: true }
      : { ok: false, message: 'Commission (3606) requires basic salary (3601)' },
  },
];

export function validateSarsCodes(ctx: SarsCodeContext): string[] {
  const errors: string[] = [];
  for (const rule of SARS_DEPENDENCY_RULES) {
    if (ctx.codes.includes(rule.code)) {
      const result = rule.requires(ctx);
      if (!result.ok) errors.push(result.message);
    }
  }
  return errors;
}
