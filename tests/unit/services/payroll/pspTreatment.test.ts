/**
 * Personal service providers (wave 6 PSP). Sources:
 * - SARS PAYE-GEN-01-G01-A06 (Other Employment Tax Deduction Tables, 2025 edition) row 6, Personal Service Provider: "Apply
 *   trusts' or companies' income tax rate": deduct 45% for a trust, 27% for a company including a close corporation;
 * - Fourth Schedule para 1, "employee" para (d) and "personal service provider"; SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 31
 *   ("Amounts received by personal service provider", code 3601) and p. 16 (an IRP3(b) directive for a PSP);
 * - UIF: UIC Act 4 of 2002 s1 "remuneration" (b): an amount in para (cA) of "gross income" (a PSP's) is not remuneration;
 * - SDL: G21 p. 12 and SDL Act s3(4): para (cA) is not among the gross-income paragraphs SDL excludes, and a PSP holds no
 *   para 2(5)(a) exemption certificate, so its payments stay leviable;
 * - ETI: ETI Act 26 of 2013 s6(b): the employee holds an ID document or permit; a company or trust holds none.
 */
import { pspTaxBasis } from '@/modules/accounting/services/payroll/pspLineRules';
import { describe, expect, it } from 'vitest';
import {
  outsideTablesResult, payeUnderTreatment, PSP_NO_ETI, pspFacts, taxStatusTreatment,
} from '@/modules/accounting/services/payroll/taxStatusTreatment';
import { getTaxYearConfig, SUPPORTED_TAX_YEARS } from '@/modules/accounting/services/payroll/taxTables';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollLineInput, PspEntityType } from '@/modules/accounting/services/payroll/payrollTypes';
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

describe('the PSP rates are table values (A06 row 6)', () => {
  it.each([...SUPPORTED_TAX_YEARS])('tax year %i: company 27%, trust 45%', (year) => {
    expect(getTaxYearConfig(year).personalServiceProviderRates).toEqual({ company: 0.27, trust: 0.45 });
  });

  it('pspFacts picks the entity\'s own rate', () => {
    expect(pspFacts({ taxStatus: 'personal_service_provider', pspEntityType: 'company' }, 2027)).toEqual({ entity: 'company', rate: 0.27 });
    expect(pspFacts({ taxStatus: 'personal_service_provider', pspEntityType: 'trust' }, 2027)).toEqual({ entity: 'trust', rate: 0.45 });
    expect(pspFacts({ taxStatus: 'employee', pspEntityType: null }, 2027)).toBeNull();
  });

  it('a PSP with no entity type is refused, never costed at a guessed rate', () => {
    expect(() => pspFacts({ taxStatus: 'personal_service_provider', pspEntityType: null }, 2027)).toThrow(/entity type/);
  });
});

describe('taxStatusTreatment: a PSP', () => {
  it('is a flat rate, no UIF, SDL on, no ETI, whatever the employment class', () => {
    for (const kind of ['standard', 'non_standard_flat', 'undetermined'] as const) {
      expect(taxStatusTreatment('personal_service_provider', kind)).toEqual({ paye: 'flat_psp', uif: false, sdl: true, eti: false });
    }
  });

  it('PAYE is the rate on the balance of remuneration, to the cent, nil below nil, nothing as an annual payment', () => {
    const tables = { regular: 1_000, annualPayment: 200 };
    expect(payeUnderTreatment('flat_psp', tables, 50_000, 0.27)).toEqual({ regular: 13_500, annualPayment: 0 });
    expect(payeUnderTreatment('flat_psp', tables, 50_000, 0.45)).toEqual({ regular: 22_500, annualPayment: 0 });
    expect(payeUnderTreatment('flat_psp', tables, 100.01, 0.27)).toEqual({ regular: 27, annualPayment: 0 });
    expect(payeUnderTreatment('flat_psp', tables, -10, 0.45)).toEqual({ regular: 0, annualPayment: 0 });
  });

  it('flat_psp with no rate throws', () => {
    expect(() => payeUnderTreatment('flat_psp', { regular: 0, annualPayment: 0 }, 1_000, null)).toThrow();
  });

  it('the line flag names the entity, the rate and the source; the year to date leaves the month out (PAYE_OUTSIDE_TABLES)', () => {
    const [flag] = outsideTablesResult('flat_psp', { entity: 'trust', rate: 0.45 });
    expect([flag!.code, flag!.treatment, flag!.severity]).toEqual(['PAYE_OUTSIDE_TABLES', 'flat_psp', 'warning']);
    expect(flag!.message).toContain('trust');
    expect(flag!.message).toContain('45%');
    expect(flag!.message).toContain('PAYE-GEN-01-G01-A06');
  });
});

function pspLine(entity: PspEntityType, over: Partial<PayrollLineInput> = {}) {
  const c: OracleCase = {
    id: `psp-${entity}`, source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: 6 }, taxYear: 2027,
      employee: {
        dateOfBirth: '1990-01-01', startDate: '2020-03-01', taxStatus: `personal_service_${entity}`, uifExcluded: false,
        medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
      },
      employerAnnualRemuneration: 2_000_000,
      components: [{ code: '3601', name: 'Fees', type: 'earning', amount: 40_000, taxable: true, uif: true, sdl: true }],
    },
    expected: {},
  };
  return calculatePayrollLine({ ...buildCaseInput(c), ...over });
}

describe('calculatePayrollLine for a PSP', () => {
  it('a company: 27% of R40 000 = R10 800, no UIF, SDL 1% = R400, no ETI', () => {
    const l = pspLine('company');
    expect(l.paye.monthlyPaye).toBe(10_800);
    expect(l.payeSplit).toEqual({ regular: 10_800, annualPayment: 0, directive: 0 });
    expect(l.uif).toEqual({ employeeContribution: 0, employerContribution: 0, isCapped: false });
    expect(l.sdl).toBe(400);
    expect(l.eti.monthlyEti).toBe(0);
    expect(l.eti.ineligibilityReason).toBe(PSP_NO_ETI);
    expect(l.medicalCredit).toBe(0);
    expect(l.netPay).toBe(29_200);
    expect(l.validationResults.filter((v) => v.code === 'PAYE_OUTSIDE_TABLES').map((v) => v.treatment)).toEqual(['flat_psp']);
  });

  it('a trust: 45% of R40 000 = R18 000', () => {
    expect(pspLine('trust').paye.monthlyPaye).toBe(18_000);
  });

  it('an IRP3(b) directive (G21 p. 16: issued for a PSP) decides PAYE over the flat rate; the line is still flagged flat_psp (the filings decide it per line)', () => {
    const l = pspLine('company', {
      regularPayDirective: {
        current: { id: 'd1', number: null, type: 'fixed_percentage', rate: 0.2, fixedAmount: null, endsOn: '2027-02-28', effectiveDate: '2026-03-01' },
        ended: null,
      },
    });
    expect(l.paye.monthlyPaye).toBe(8_000);
    expect(l.validationResults.filter((v) => v.code === 'PAYE_OUTSIDE_TABLES').map((v) => v.treatment)).toEqual(['flat_psp', 'directive']);
    expect(pspTaxBasis(l.validationResults)).toBe('Personal service provider (company): PAYE as the IRP3(b) directive directs, no UIF');
  });

  it('the explanation states the PSP rate and source, and says why there is no UIF', () => {
    const { paye, uif } = pspLine('trust').explanations!;
    const keys = paye.steps.map((s) => s.key);
    expect(keys).toEqual(['paye.treatment', 'paye.balance', 'paye.flatRate', 'paye.flat']);
    expect(paye.steps.find((s) => s.key === 'paye.flatRate')!.amount).toBe(0.45);
    expect(paye.steps.find((s) => s.key === 'paye.flat')!.amount).toBe(18_000);
    expect(paye.steps[0]!.label).toContain('trust');
    expect(paye.steps[0]!.source!.label).toContain('PAYE-GEN-01-G01-A06');
    expect(paye.result).toBe(18_000);
    expect(uif.steps[0]!.label).toContain('Personal service provider');
  });
});
