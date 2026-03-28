/**
 * TDD: SARS e-Filing Integration Tests
 * RED phase — written before implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  buildVAT201Payload,
  buildEMP201Payload,
  buildIRP6Payload,
  validateSARSSubmission,
  calculateComplianceDeadlines,
  formatSARSDate,
  formatSARSCurrency,
  SARS_TAX_TYPES,
  type VAT201Data,
  type EMP201Data,
  type IRP6Data,
  type ComplianceDeadline,
} from '@/modules/accounting/services/sarsEfilingService';

// ═══════════════════════════════════════════════════════════════════════════
// SARS TAX TYPES
// ═══════════════════════════════════════════════════════════════════════════

describe('SARS Tax Types', () => {
  it('includes VAT', () => {
    expect(SARS_TAX_TYPES.VAT201).toBeDefined();
    expect(SARS_TAX_TYPES.VAT201.name).toContain('VAT');
  });

  it('includes EMP201', () => {
    expect(SARS_TAX_TYPES.EMP201).toBeDefined();
  });

  it('includes EMP501', () => {
    expect(SARS_TAX_TYPES.EMP501).toBeDefined();
  });

  it('includes IRP6 (provisional tax)', () => {
    expect(SARS_TAX_TYPES.IRP6).toBeDefined();
    expect(SARS_TAX_TYPES.IRP6.name).toContain('rovisional');
  });

  it('includes IT14 (company tax)', () => {
    expect(SARS_TAX_TYPES.IT14).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VAT201 PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

describe('VAT201 Payload Building', () => {
  const sampleVAT: VAT201Data = {
    taxPeriod: '2026-03',
    vatNumber: '4123456789',
    companyName: 'IsaFlow Pty Ltd',
    outputVATStandard: 150000,
    outputVATZeroRated: 0,
    outputVATExempt: 0,
    inputVATCapitalGoods: 20000,
    inputVATOther: 80000,
    adjustments: 0,
  };

  it('builds valid payload structure', () => {
    const payload = buildVAT201Payload(sampleVAT);
    expect(payload).toBeDefined();
    expect(payload.taxType).toBe('VAT201');
    expect(payload.taxPeriod).toBe('2026-03');
  });

  it('calculates total output VAT', () => {
    const payload = buildVAT201Payload(sampleVAT);
    expect(payload.totalOutputVAT).toBe(150000);
  });

  it('calculates total input VAT', () => {
    const payload = buildVAT201Payload(sampleVAT);
    expect(payload.totalInputVAT).toBe(100000); // 20000 + 80000
  });

  it('calculates net VAT payable', () => {
    const payload = buildVAT201Payload(sampleVAT);
    expect(payload.netVAT).toBe(50000); // 150000 - 100000
  });

  it('handles VAT refund scenario (input > output)', () => {
    const refund = buildVAT201Payload({
      ...sampleVAT,
      outputVATStandard: 50000,
      inputVATOther: 80000,
    });
    expect(refund.netVAT).toBe(-50000); // 50000 - (20000 + 80000) = -50000 refund
  });

  it('includes all field values', () => {
    const payload = buildVAT201Payload(sampleVAT);
    expect(payload.fields).toBeDefined();
    expect(payload.fields.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EMP201 PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

describe('EMP201 Payload Building', () => {
  const sampleEMP: EMP201Data = {
    taxPeriod: '2026-03',
    payeReference: '7001234567',
    companyName: 'IsaFlow Pty Ltd',
    totalPAYE: 72000,
    totalUIF: 4272,
    totalSDL: 4200,
    employeeCount: 10,
  };

  it('builds valid payload', () => {
    const payload = buildEMP201Payload(sampleEMP);
    expect(payload.taxType).toBe('EMP201');
    expect(payload.payeReference).toBe('7001234567');
  });

  it('calculates total liability', () => {
    const payload = buildEMP201Payload(sampleEMP);
    expect(payload.totalLiability).toBe(80472); // 72000 + 4272 + 4200
  });

  it('includes PAYE, UIF, SDL breakdown', () => {
    const payload = buildEMP201Payload(sampleEMP);
    expect(payload.paye).toBe(72000);
    expect(payload.uif).toBe(4272);
    expect(payload.sdl).toBe(4200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IRP6 (PROVISIONAL TAX) PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

describe('IRP6 Payload Building', () => {
  const sampleIRP6: IRP6Data = {
    taxYear: 2026,
    period: 1, // 1st provisional (August)
    taxableIncome: 500000,
    taxCredits: 0,
    previousPayments: 0,
    companyName: 'IsaFlow Pty Ltd',
    taxNumber: '1234567890',
  };

  it('builds valid payload', () => {
    const payload = buildIRP6Payload(sampleIRP6);
    expect(payload.taxType).toBe('IRP6');
    expect(payload.taxYear).toBe(2026);
    expect(payload.period).toBe(1);
  });

  it('calculates estimated tax', () => {
    const payload = buildIRP6Payload(sampleIRP6);
    expect(payload.estimatedTax).toBeGreaterThan(0);
  });

  it('calculates amount due after credits', () => {
    const payload = buildIRP6Payload({
      ...sampleIRP6,
      taxCredits: 10000,
      previousPayments: 20000,
    });
    expect(payload.amountDue).toBe(payload.estimatedTax - 10000 - 20000);
  });

  it('1st provisional = basic estimate (50% of annual)', () => {
    const payload = buildIRP6Payload(sampleIRP6);
    // For period 1, estimate is roughly half the annual tax
    expect(payload.estimatedTax).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBMISSION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('SARS Submission Validation', () => {
  it('validates valid VAT submission', () => {
    expect(validateSARSSubmission({
      taxType: 'VAT201',
      taxPeriod: '2026-03',
      vatNumber: '4123456789',
    }).valid).toBe(true);
  });

  it('rejects missing tax type', () => {
    expect(validateSARSSubmission({
      taxType: '',
      taxPeriod: '2026-03',
    }).valid).toBe(false);
  });

  it('rejects missing tax period', () => {
    expect(validateSARSSubmission({
      taxType: 'VAT201',
      taxPeriod: '',
    }).valid).toBe(false);
  });

  it('validates VAT number format (10 digits starting with 4)', () => {
    expect(validateSARSSubmission({
      taxType: 'VAT201',
      taxPeriod: '2026-03',
      vatNumber: '4123456789',
    }).valid).toBe(true);
  });

  it('rejects invalid VAT number', () => {
    expect(validateSARSSubmission({
      taxType: 'VAT201',
      taxPeriod: '2026-03',
      vatNumber: '123',
    }).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPLIANCE DEADLINES
// ═══════════════════════════════════════════════════════════════════════════

describe('Compliance Deadlines', () => {
  it('calculates VAT due dates for the year', () => {
    const deadlines = calculateComplianceDeadlines(2026);
    const vatDeadlines = deadlines.filter(d => d.taxType === 'VAT201');
    // VAT201 is due monthly or bi-monthly
    expect(vatDeadlines.length).toBeGreaterThan(0);
  });

  it('calculates EMP201 monthly due dates', () => {
    const deadlines = calculateComplianceDeadlines(2026);
    const empDeadlines = deadlines.filter(d => d.taxType === 'EMP201');
    expect(empDeadlines.length).toBe(12); // Monthly
  });

  it('includes EMP501 bi-annual deadlines', () => {
    const deadlines = calculateComplianceDeadlines(2026);
    const emp501 = deadlines.filter(d => d.taxType === 'EMP501');
    expect(emp501.length).toBe(2); // Interim + Annual
  });

  it('includes IRP6 provisional tax dates', () => {
    const deadlines = calculateComplianceDeadlines(2026);
    const irp6 = deadlines.filter(d => d.taxType === 'IRP6');
    expect(irp6.length).toBe(2); // 1st and 2nd provisional
  });

  it('deadlines have correct structure', () => {
    const deadlines = calculateComplianceDeadlines(2026);
    for (const d of deadlines) {
      expect(d).toHaveProperty('taxType');
      expect(d).toHaveProperty('dueDate');
      expect(d).toHaveProperty('description');
      expect(d).toHaveProperty('period');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

describe('SARS Formatting', () => {
  it('formats date as CCYYMMDD', () => {
    expect(formatSARSDate('2026-03-15')).toBe('20260315');
  });

  it('formats currency to cents string', () => {
    expect(formatSARSCurrency(15000.50)).toBe('1500050');
    expect(formatSARSCurrency(0)).toBe('0');
  });
});
