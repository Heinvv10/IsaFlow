/**
 * Unit tests for paygEligibilityService — each gate in isolation plus the OR composite.
 * Mocks @/lib/neon.sql with a stack of responses.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { isEligible } from '@/modules/onboarding/services/paygEligibilityService';

const mockSql = sql as unknown as MockedFunction<typeof sql>;

beforeEach(() => {
  vi.clearAllMocks();
});

// The service issues two queries: companies row, then gl_journal_entries count.
function stubCompany(row: { payg_eligible: boolean; annual_turnover_cents: number | null } | null) {
  mockSql.mockResolvedValueOnce((row ? [row] : []) as never);
}
function stubVolume(count: number) {
  mockSql.mockResolvedValueOnce([{ total: count }] as never);
}

describe('isEligible', () => {
  it('returns ineligible when the company is not found', async () => {
    stubCompany(null);
    // No volume query is issued when company row is missing.
    const result = await isEligible('missing-co');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('ineligible');
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('eligible by admin flag takes priority over other gates', async () => {
    stubCompany({ payg_eligible: true, annual_turnover_cents: 500_000_000 }); // R5M turnover
    stubVolume(9999); // way over the volume threshold
    const result = await isEligible('co-1');
    expect(result).toEqual({
      eligible: true,
      reason: 'admin',
      signals: { monthlyTransactions: 3333, annualTurnoverCents: 500_000_000, adminFlagged: true },
    });
  });

  it('eligible by declared turnover under R1M', async () => {
    stubCompany({ payg_eligible: false, annual_turnover_cents: 50_000_000 }); // R500k
    stubVolume(9999); // volume fails, turnover wins
    const result = await isEligible('co-2');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('turnover');
  });

  it('eligible by volume when average monthly tx < 200', async () => {
    stubCompany({ payg_eligible: false, annual_turnover_cents: null });
    stubVolume(150); // 150 / 3 = 50 → under 200
    const result = await isEligible('co-3');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('volume');
    expect(result.signals.monthlyTransactions).toBe(50);
  });

  it('ineligible when all gates fail', async () => {
    stubCompany({ payg_eligible: false, annual_turnover_cents: 200_000_000 }); // R2M
    stubVolume(900); // 900 / 3 = 300 → over threshold
    const result = await isEligible('co-4');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('ineligible');
  });

  it('turnover = exactly R1M does NOT qualify (strict <)', async () => {
    stubCompany({ payg_eligible: false, annual_turnover_cents: 100_000_000 });
    stubVolume(900);
    const result = await isEligible('co-5');
    expect(result.eligible).toBe(false);
  });

  it('volume = exactly 200/month does NOT qualify (strict <)', async () => {
    stubCompany({ payg_eligible: false, annual_turnover_cents: null });
    stubVolume(600); // 600 / 3 = 200 exactly
    const result = await isEligible('co-6');
    expect(result.eligible).toBe(false);
  });
});
