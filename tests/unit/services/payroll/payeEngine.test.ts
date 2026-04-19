import { describe, it, expect } from 'vitest';
import { calculatePAYE } from '@/modules/accounting/services/payroll/payeEngine';

describe('PAYE engine — 2024/2025 tax year', () => {
  it('returns zero for income below threshold (age < 65)', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 90_000,
      ageAtPeriodEnd: 25,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBe(0);
    expect(result.annualTax).toBe(0);
  });

  it('golden-file: R25,000/month, age 30, no medical', () => {
    // Annual R300,000 → bracket 2: R42,678 + 26% × 62,900 = R59,032
    // Less primary rebate R17,235 → R41,797 annual → R3,483.08/month
    const result = calculatePAYE({
      annualTaxableIncome: 300_000,
      ageAtPeriodEnd: 30,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(41_797, 0);
    expect(result.monthlyPaye).toBeCloseTo(3_483.08, 1);
    expect(result.effectiveRate).toBeCloseTo(0.1393, 3);
  });

  it('golden-file: R50,000/month, age 45, 2 medical beneficiaries', () => {
    // Annual R600,000 → bracket 4: R121,475 + 36% × 87,200 = R152,867
    // Less primary rebate R17,235 → R135,632
    // Medical credits: R364 × 2 × 12 = R8,736
    // Net annual PAYE: R126,896 → monthly R10,574.67
    const result = calculatePAYE({
      annualTaxableIncome: 600_000,
      ageAtPeriodEnd: 45,
      monthlyMedicalBeneficiaries: 2,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(126_896, 0);
    expect(result.monthlyPaye).toBeCloseTo(10_574.67, 1);
    expect(result.medicalCreditsApplied).toBeCloseTo(8_736, 0);
  });

  it('golden-file: age 66, R20,000/month (secondary rebate applies)', () => {
    // Annual R240,000 → bracket 2: R42,678 + 26% × 2,900 = R43,432
    // Less primary + secondary: R17,235 + R9,444 = R26,679
    // Annual PAYE: R16,753 → monthly R1,396.08
    const result = calculatePAYE({
      annualTaxableIncome: 240_000,
      ageAtPeriodEnd: 66,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(16_753, 0);
    expect(result.monthlyPaye).toBeCloseTo(1_396.08, 1);
    expect(result.rebatesApplied).toBeCloseTo(26_679, 0);
  });

  it('age 66, income below 65-74 threshold → zero PAYE', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 140_000,
      ageAtPeriodEnd: 66,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBe(0);
  });

  it('golden-file: R100,000/month, age 50, 4 medical beneficiaries', () => {
    // Annual R1,200,000 → bracket 6: R251,258 + 41% × 342,100 = R391,519
    // Less primary: R17,235 → R374,284
    // Medical credits: 2×R364×12 + 2×R246×12 = R8,736 + R5,904 = R14,640
    // Net: R374,284 - R14,640 = R359,644 → monthly R29,970.33
    const result = calculatePAYE({
      annualTaxableIncome: 1_200_000,
      ageAtPeriodEnd: 50,
      monthlyMedicalBeneficiaries: 4,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(359_644, 0);
    expect(result.monthlyPaye).toBeCloseTo(29_970.33, 1);
  });

  it('PAYE never goes negative', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 100_000,
      ageAtPeriodEnd: 30,
      monthlyMedicalBeneficiaries: 10,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBeGreaterThanOrEqual(0);
    expect(result.annualTax).toBeGreaterThanOrEqual(0);
  });
});
