// RED phase — written before implementation (review-fix round)
/**
 * Validation tests for the compliance obligations config gate.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  validateObligations,
  type ComplianceObligations,
} from '@/modules/bureau/services/complianceObligationsService';

function input(overrides: Partial<ComplianceObligations> = {}): ComplianceObligations {
  return {
    vatEnabled: true,
    emp201Enabled: true,
    emp501Enabled: false,
    provisionalTaxEnabled: false,
    cipcEnabled: false,
    yearEndMonth: 2,
    cipcAnniversaryMonth: null,
    ...overrides,
  };
}

describe('validateObligations', () => {
  it('accepts a valid config', () => {
    expect(validateObligations(input())).toBeNull();
  });

  it('rejects an out-of-range or fractional yearEndMonth', () => {
    expect(validateObligations(input({ yearEndMonth: 0 }))).toMatch(/yearEndMonth/);
    expect(validateObligations(input({ yearEndMonth: 13 }))).toMatch(/yearEndMonth/);
    expect(validateObligations(input({ yearEndMonth: 1.5 }))).toMatch(/yearEndMonth/);
    expect(validateObligations(input({ yearEndMonth: NaN }))).toMatch(/yearEndMonth/);
  });

  it('rejects an out-of-range cipcAnniversaryMonth', () => {
    expect(validateObligations(input({ cipcAnniversaryMonth: 13 }))).toMatch(/cipcAnniversaryMonth/);
    expect(validateObligations(input({ cipcAnniversaryMonth: 0 }))).toMatch(/cipcAnniversaryMonth/);
  });

  it('requires an anniversary month when CIPC is enabled', () => {
    expect(validateObligations(input({ cipcEnabled: true, cipcAnniversaryMonth: null }))).toMatch(/required/);
    expect(validateObligations(input({ cipcEnabled: true, cipcAnniversaryMonth: 7 }))).toBeNull();
  });

  it('allows a null anniversary month when CIPC is disabled', () => {
    expect(validateObligations(input({ cipcEnabled: false, cipcAnniversaryMonth: null }))).toBeNull();
  });
});
