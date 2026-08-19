/**
 * Unit tests for waitlistPromotionService — the pure `buildCompanySeed`
 * mapper plus the DB-touching `promoteWaitlistSignup` orchestration.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/admin/services/adminCompanyService', () => ({
  createCompany: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { createCompany } from '@/modules/admin/services/adminCompanyService';
import {
  buildCompanySeed,
  promoteWaitlistSignup,
  type WaitlistSignupRow,
} from '@/modules/onboarding/services/waitlistPromotionService';

const mockSql = sql as unknown as MockedFunction<typeof sql>;
const mockCreateCompany = createCompany as unknown as MockedFunction<typeof createCompany>;

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

describe('promoteWaitlistSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const waitlistId = '00000000-0000-0000-0000-000000000042';
  const row = signup({ id: waitlistId, annual_turnover_cents: 50_000_000, phone: '+27821234567' });

  function stubLoadSignup(r: WaitlistSignupRow | null) {
    mockSql.mockResolvedValueOnce((r ? [r] : []) as never);
  }
  function stubAlreadyPromoted(companyId: string | null) {
    mockSql.mockResolvedValueOnce([{ promoted_company_id: companyId }] as never);
  }
  function stubPending() {
    mockSql.mockResolvedValueOnce([] as never); // existing.length === 0 → proceed
  }
  function stubPlanLookup(planId: string | null) {
    mockSql.mockResolvedValueOnce((planId ? [{ id: planId }] : []) as never);
  }
  function stubUpdateStamp() {
    mockSql.mockResolvedValueOnce([] as never); // UPDATE RETURNING (unused)
  }

  it('returns not_found when the waitlist row is missing', async () => {
    stubLoadSignup(null);
    const result = await promoteWaitlistSignup(waitlistId);
    expect(result.status).toBe('not_found');
    expect(result.companyId).toBeNull();
    expect(mockCreateCompany).not.toHaveBeenCalled();
  });

  it('returns already_promoted without creating a duplicate company', async () => {
    stubLoadSignup(row);
    stubAlreadyPromoted('company-xyz');
    const result = await promoteWaitlistSignup(waitlistId);
    expect(result.status).toBe('already_promoted');
    expect(result.companyId).toBe('company-xyz');
    expect(mockCreateCompany).not.toHaveBeenCalled();
  });

  it('promotes a PAYG-eligible direct signup with the payg plan', async () => {
    stubLoadSignup(row);
    stubPending();
    stubPlanLookup('plan-payg-uuid');
    mockCreateCompany.mockResolvedValueOnce({ id: 'company-new', name: 'Acme (Pty) Ltd' });
    stubUpdateStamp();

    const result = await promoteWaitlistSignup(waitlistId);

    expect(result.status).toBe('promoted');
    expect(result.companyId).toBe('company-new');
    expect(result.planCode).toBe('payg');
    expect(mockCreateCompany).toHaveBeenCalledWith({
      name: 'Acme (Pty) Ltd',
      email: 'jane@example.co.za',
      phone: '+27821234567',
      plan_id: 'plan-payg-uuid',
      annual_turnover_cents: 50_000_000,
      payg_eligible: true,
    });
  });

  it('never inserts a subscription itself — createCompany owns that write', async () => {
    // Regression guard: createCompany already inserts the subscriptions row when
    // plan_id is set. A second INSERT here produced two conflicting rows for the
    // same company (one trial, one active) — subscriptions has no unique
    // constraint on company_id, so nothing caught it at the DB level.
    stubLoadSignup(row);
    stubPending();
    stubPlanLookup('plan-payg-uuid');
    mockCreateCompany.mockResolvedValueOnce({ id: 'company-new', name: 'Acme (Pty) Ltd' });
    stubUpdateStamp();

    await promoteWaitlistSignup(waitlistId);

    const statements = mockSql.mock.calls
      .map((call) => (Array.isArray(call[0]) ? (call[0] as string[]).join(' ? ') : ''))
      .join('\n---\n');
    expect(statements).not.toMatch(/INSERT\s+INTO\s+subscriptions/i);
  });

  it('honours planCodeOverride over the seed suggestion', async () => {
    stubLoadSignup(row);
    stubPending();
    stubPlanLookup('plan-starter-uuid');
    mockCreateCompany.mockResolvedValueOnce({ id: 'company-new', name: 'Acme (Pty) Ltd' });
    stubUpdateStamp();

    const result = await promoteWaitlistSignup(waitlistId, { planCodeOverride: 'starter' });

    expect(result.planCode).toBe('starter');
    expect(mockCreateCompany).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan-starter-uuid',
    }));
  });

  it('proceeds without a plan when the plan code lookup returns nothing', async () => {
    stubLoadSignup(row);
    stubPending();
    stubPlanLookup(null); // unknown plan code
    mockCreateCompany.mockResolvedValueOnce({ id: 'company-new', name: 'Acme (Pty) Ltd' });
    stubUpdateStamp();

    const result = await promoteWaitlistSignup(waitlistId, { planCodeOverride: 'bogus' });

    expect(result.status).toBe('promoted');
    expect(mockCreateCompany).toHaveBeenCalledWith(expect.objectContaining({ plan_id: null }));
  });

  it('promotes a bureau signup with no plan suggestion', async () => {
    const bureau = signup({
      id: waitlistId,
      signup_type: 'accountant',
      company_name: null,
      practice_name: 'Smith & Co',
      annual_turnover_cents: 25_000_000,
    });
    stubLoadSignup(bureau);
    stubPending();
    // No plan lookup expected — suggestedPlanCode is null for bureaus and no override given.
    mockCreateCompany.mockResolvedValueOnce({ id: 'company-bureau', name: 'Smith & Co' });
    stubUpdateStamp();

    const result = await promoteWaitlistSignup(waitlistId);

    expect(result.planCode).toBeNull();
    expect(mockCreateCompany).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Smith & Co',
      plan_id: null,
      payg_eligible: true, // computed but no plan assigned
    }));
  });
});
