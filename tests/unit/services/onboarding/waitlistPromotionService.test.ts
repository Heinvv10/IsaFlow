/**
 * Unit tests for waitlistPromotionService.buildCompanySeed — locks in the
 * signup → company PAYG-eligibility policy.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCompanySeed,
  type WaitlistSignupRow,
} from '@/modules/onboarding/services/waitlistPromotionService';

function signup(overrides: Partial<WaitlistSignupRow>): WaitlistSignupRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Jane Doe',
    email: 'jane@example.co.za',
    signup_type: 'direct',
    company_name: 'Acme (Pty) Ltd',
    practice_name: null,
    phone: null,
    annual_turnover_cents: null,
    ...overrides,
  };
}

describe('buildCompanySeed', () => {
  it('flags PAYG-eligible when direct signup declares turnover under R1M', () => {
    const seed = buildCompanySeed(signup({ annual_turnover_cents: 50_000_000 })); // R500k
    expect(seed.paygEligible).toBe(true);
    expect(seed.suggestedPlanCode).toBe('payg');
    expect(seed.annualTurnoverCents).toBe(50_000_000);
  });

  it('does not flag PAYG-eligible at the R1M threshold', () => {
    const seed = buildCompanySeed(signup({ annual_turnover_cents: 100_000_000 }));
    expect(seed.paygEligible).toBe(false);
    expect(seed.suggestedPlanCode).toBe('starter');
  });

  it('leaves suggestion null when turnover is undeclared', () => {
    const seed = buildCompanySeed(signup({ annual_turnover_cents: null }));
    expect(seed.paygEligible).toBe(false);
    expect(seed.suggestedPlanCode).toBeNull();
    expect(seed.annualTurnoverCents).toBeNull();
  });

  it('never auto-suggests PAYG for bureau (accountant) signups', () => {
    const seed = buildCompanySeed(signup({
      signup_type: 'accountant',
      company_name: null,
      practice_name: 'Smith & Associates',
      annual_turnover_cents: 25_000_000, // R250k — would qualify for direct
    }));
    expect(seed.paygEligible).toBe(true);      // eligibility still computed…
    expect(seed.suggestedPlanCode).toBeNull(); // …but no suggestion for bureaus
    expect(seed.name).toBe('Smith & Associates');
  });

  it('falls back to email local-part when no company/practice name provided', () => {
    const seed = buildCompanySeed(signup({ company_name: null, email: 'solo@ex.co' }));
    expect(seed.name).toBe('solo');
  });

  it('ignores turnover=0 — treated as declared and >= threshold? no, zero is below', () => {
    // A declared zero turnover is a real declaration (e.g. brand-new entity)
    // and still qualifies for PAYG under the < R1M rule.
    const seed = buildCompanySeed(signup({ annual_turnover_cents: 0 }));
    expect(seed.paygEligible).toBe(true);
    expect(seed.suggestedPlanCode).toBe('payg');
  });
});
