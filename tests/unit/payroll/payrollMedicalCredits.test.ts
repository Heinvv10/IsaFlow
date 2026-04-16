import { describe, it, expect } from 'vitest';
import { calculateMedicalCredits } from '@/modules/payroll/taxTables';

describe('Medical aid tax credits', () => {
  it('no main member → R0', () => {
    expect(calculateMedicalCredits(false, 0)).toBe(0);
    expect(calculateMedicalCredits(false, 3)).toBe(0);
  });

  it('main member only → R364', () => {
    expect(calculateMedicalCredits(true, 0)).toBe(364);
  });

  it('main + 1 dependant → R728', () => {
    expect(calculateMedicalCredits(true, 1)).toBe(728);
  });

  it('main + 2 dependants → R974 (R728 + R246)', () => {
    expect(calculateMedicalCredits(true, 2)).toBe(974);
  });

  it('main + 4 dependants → R1,466', () => {
    // 364 + 364 + 3 × 246 = 1466
    expect(calculateMedicalCredits(true, 4)).toBe(1466);
  });
});

describe('Medical credits reduce PAYE (simulated usage)', () => {
  it('applies credit then floors at 0', () => {
    const grossPaye = 1000;
    const credit = calculateMedicalCredits(true, 2); // 974
    expect(Math.max(0, grossPaye - credit)).toBe(26);
  });

  it('credit larger than gross PAYE floors at 0', () => {
    const grossPaye = 500;
    const credit = calculateMedicalCredits(true, 2); // 974
    expect(Math.max(0, grossPaye - credit)).toBe(0);
  });
});
