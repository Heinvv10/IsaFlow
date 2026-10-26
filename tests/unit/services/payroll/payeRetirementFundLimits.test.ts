/**
 * PAYE 4c review (#891): the s11F deduction's limits through the cumulative PAYE.
 * - The deduction to date never exceeds the contributions to date, nor the year's cap (property test).
 * - The cap switches with the tax year: R350 000 for 2026 (SARS PAYE-GEN-01-G20 (2026) p. 5), R430 000 for
 *   2027 (PAYE-GEN-01-G21 (2027) p. 5, p. 10).
 * - A leaver: the cap "at any time during the year" is limited to the period paid (G21 (2027) p. 10), so six
 *   months take at most half the year's cap.
 * - The 27.5% base is "taxable income before allowing any deduction under ss11F, 6quat(1C) and 18A" (G21 (2027)
 *   p. 10): a donation (4030, s18A) does not shrink it.
 * Hand figures: 2026 table = 2025's (taxTables.ts): 1 817 001+ at 644 489 + 45%, rebate 17 235; 2027: 1 878 601+
 * at 666 339 + 45%, rebate 17 820.
 */
import { describe, expect, it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };
const r2 = (n: number) => Math.round(n * 100) / 100;
interface Month { salary: number; contribution: number; bonus?: number; donation?: number }

function year(months: Month[], taxYear = 2027) {
  let ytd: PayeYearToDate = NONE;
  return months.map((m) => {
    const r = calculateCumulativePaye({
      taxYear, rebateAge: 40, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0,
      regularTaxable: m.salary - (m.donation ?? 0), annualPayments: m.bonus ?? 0,
      retirementContributions: m.contribution, donations: m.donation ?? 0, ytd,
    });
    const total = r2(r.regular.monthlyPaye + r.annualPaymentPaye);
    ytd = {
      ...ytd,
      periods: ytd.periods + (m.salary > 0 ? 1 : 0), periodicTaxable: ytd.periodicTaxable + m.salary - (m.donation ?? 0),
      annualPayments: ytd.annualPayments + (m.bonus ?? 0), tablePaye: r2(ytd.tablePaye + total),
      retirementContributions: r2((ytd.retirementContributions ?? 0) + m.contribution),
      retirementDeduction: r2((ytd.retirementDeduction ?? 0) + r.retirementDeduction),
      donations: r2((ytd.donations ?? 0) + (m.donation ?? 0)),
    };
    return { ...r, total, deductedToDate: ytd.retirementDeduction!, contributedToDate: ytd.retirementContributions! };
  });
}

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

describe('s11F limits in the cumulative PAYE', () => {
  it('property: in every month the deduction to date is ≤ the contributions to date and ≤ the cap × n ÷ 12', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed);
      // A third of the years are low pay with big bonuses and big contributions: the bonus path.
      const lowPayBigBonus = next() < 0.33;
      const months: Month[] = Array.from({ length: 12 }, () => ({
        salary: next() < 0.1 ? 0 : Math.round(next() * (lowPayBigBonus ? 15_000 : 250_000)),
        contribution: Math.round(next() * (lowPayBigBonus || next() < 0.2 ? 600_000 : 15_000)),
        bonus: next() < (lowPayBigBonus ? 0.5 : 0.2) ? Math.round(next() * 3_000_000) : 0,
      }));
      let paid = 0;
      for (const [i, m] of year(months).entries()) {
        if (months[i]!.salary > 0) paid += 1;
        const at = `seed ${seed} month ${i + 1}`;
        expect(m.deductedToDate, at).toBeLessThanOrEqual(m.contributedToDate + 0.01);
        // "At any time during the year" at most the cap × the periods paid ÷ 12 (G21 (2027) p. 10).
        expect(m.deductedToDate, at).toBeLessThanOrEqual((430_000 * Math.max(paid, 1)) / 12 + 0.01);
      }
    }
  });

  it('a one-month year in 2026 and one in 2027 each take their own cap: R200 000 with R50 000 RA deducts 29 166.67, then 35 833.33', () => {
    // 2026: taxable 2 400 000 − 350 000 = 2 050 000: 644 489 + 45% × 233 000 = 749 339 − 17 235 = 732 104 ÷ 12.
    const y26 = year([{ salary: 200_000, contribution: 50_000 }], 2026)[0]!;
    expect([y26.retirementDeduction, y26.total]).toEqual([29_166.67, 61_008.67]);
    const y27 = year([{ salary: 200_000, contribution: 50_000 }], 2027)[0]!;
    expect([y27.retirementDeduction, y27.total]).toEqual([35_833.33, 57_470.75]);
  });

  it('a leaver after six months: at most half the year\'s cap (215 000), however much was contributed', () => {
    const months = year(Array(6).fill({ salary: 200_000, contribution: 50_000 }));
    expect(months[5]!.deductedToDate).toBe(215_000);
    expect(months[5]!.contributedToDate).toBe(300_000);
  });

  it('a bonus month is held to the cap × n ÷ 12 too: R10 000 pay, R2 000 000 bonus, R500 000 RA deducts 35 833.33 (review #891 round 2)', () => {
    // AE 120 000 (10 000 to date); base 2 120 000 × 27.5% = 583 000, capped at 430 000; to date at most 430 000 ÷ 12
    // = 35 833.33, so 25 833.33 off the bonus (it took 320 000). tax(2 000 000 − 25 833.33 = 1 974 166.67)
    // = 666 339 + 45% × 95 566.67 = 709 344.00 − 17 820 = 691 524.00, all of it the bonus's.
    const m = year([{ salary: 10_000, contribution: 500_000, bonus: 2_000_000 }])[0]!;
    expect([m.deductedToDate, m.regular.monthlyPaye, m.annualPaymentPaye]).toEqual([35_833.33, 0, 691_524]);
  });

  it('a donation (4030, s18A) does not shrink the 27.5% base: R20 000, R1 000 donated, R8 000 RA deducts 5 500', () => {
    // Base 27.5% × 240 000 = 66 000 (not × 228 000 = 62 700). Taxable 240 000 − 12 000 − 66 000 = 162 000 × 18%
    // = 29 160 − 17 820 = 11 340 ÷ 12 = 945.
    const m = year([{ salary: 20_000, contribution: 8_000, donation: 1_000 }])[0]!;
    expect([m.retirementDeduction, m.total]).toEqual([5_500, 945]);
  });
});
