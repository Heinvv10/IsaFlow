/**
 * Tenant provisioning policy + SQL shape.
 *
 * Policy is pure, so it's asserted directly. The provisioning itself is
 * exercised against a fake QueryRunner that records every statement — this
 * catches the class of bug that motivated the whole change: a tenant created
 * without a subscription row, or with plan written to the vestigial
 * `companies.plan_id` column.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isPaygEligible,
  suggestedPlanCode,
  trialEndsAt,
  provisionTenant,
  TRIAL_DAYS,
  TURNOVER_THRESHOLD_CENTS,
  type QueryRunner,
} from '@/modules/onboarding/services/tenantProvisioningService';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const R900k = 90_000_000;
const R1_2m = 120_000_000;

describe('isPaygEligible', () => {
  it('is true below R1m', () => {
    expect(isPaygEligible(R900k)).toBe(true);
  });

  it('is false at exactly R1m — the threshold is exclusive', () => {
    expect(isPaygEligible(TURNOVER_THRESHOLD_CENTS)).toBe(false);
  });

  it('is false above R1m', () => {
    expect(isPaygEligible(R1_2m)).toBe(false);
  });

  it('is false when undeclared — an absent claim is not a micro-enterprise claim', () => {
    expect(isPaygEligible(null)).toBe(false);
  });

  it('treats a declared zero turnover as eligible, not as undeclared', () => {
    expect(isPaygEligible(0)).toBe(true);
  });
});

describe('suggestedPlanCode', () => {
  it('suggests payg for a micro direct signup', () => {
    expect(suggestedPlanCode(R900k, 'direct')).toBe('payg');
  });

  it('suggests starter for a larger direct signup', () => {
    expect(suggestedPlanCode(R1_2m, 'direct')).toBe('starter');
  });

  it('suggests nothing when turnover is undeclared', () => {
    expect(suggestedPlanCode(null, 'direct')).toBeNull();
  });

  it('never auto-suggests for accountants — bureaus do not declare own turnover', () => {
    expect(suggestedPlanCode(R900k, 'accountant')).toBeNull();
    expect(suggestedPlanCode(R1_2m, 'accountant')).toBeNull();
  });
});

describe('trialEndsAt', () => {
  it(`is exactly ${TRIAL_DAYS} days after creation`, () => {
    const from = new Date('2026-08-19T10:00:00.000Z');
    const end = trialEndsAt(from);
    expect(end.toISOString()).toBe('2026-09-02T10:00:00.000Z');
    expect((end.getTime() - from.getTime()) / 86_400_000).toBe(TRIAL_DAYS);
  });
});

/** Records every statement so the test can assert on shape, not just outcome. */
function fakeRunner(opts: { trialPlanExists?: boolean } = {}): {
  runner: QueryRunner;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const runner: QueryRunner = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/INSERT INTO companies/i.test(text)) return { rows: [{ id: 'company-1' }] } as never;
      if (/FROM plans/i.test(text)) {
        return {
          rows: opts.trialPlanExists === false ? [] : [{ id: 'plan-trial' }],
        } as never;
      }
      if (/INSERT INTO subscriptions/i.test(text)) return { rows: [{ id: 'sub-1' }] } as never;
      return { rows: [] } as never;
    },
  };
  return { runner, calls };
}

const baseInput = {
  ownerUserId: 'user-1',
  email: 'lead@example.co.za',
  firstName: 'Lead',
  lastName: 'Person',
  companyName: 'Lead Co',
  phone: null,
  annualTurnoverCents: R900k,
  signupType: 'direct' as const,
};

describe('provisionTenant', () => {
  const now = new Date('2026-08-19T10:00:00.000Z');

  it('creates company, trial subscription, owner membership and profile', async () => {
    const { runner, calls } = fakeRunner();
    const result = await provisionTenant(runner, baseInput, now);

    expect(result.companyId).toBe('company-1');
    expect(result.subscriptionId).toBe('sub-1');
    expect(result.paygEligible).toBe(true);
    expect(result.trialEndsAt.toISOString()).toBe('2026-09-02T10:00:00.000Z');

    const statements = calls.map((c) => c.text).join('\n---\n');
    expect(statements).toMatch(/INSERT INTO companies/i);
    expect(statements).toMatch(/INSERT INTO subscriptions/i);
    expect(statements).toMatch(/INSERT INTO company_users/i);
    expect(statements).toMatch(/INSERT INTO users/i);
  });

  it('writes the plan to subscriptions, never to the vestigial companies.plan_id', async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);

    const companyInsert = calls.find((c) => /INSERT INTO companies/i.test(c.text))!;
    expect(companyInsert.text).not.toMatch(/plan_id/i);

    const subInsert = calls.find((c) => /INSERT INTO subscriptions/i.test(c.text))!;
    expect(subInsert.text).toMatch(/plan_id/i);
    expect(subInsert.values).toContain('plan-trial');
  });

  it("sets the subscription to status 'trial' with a period matching the trial", async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);

    const subInsert = calls.find((c) => /INSERT INTO subscriptions/i.test(c.text))!;
    expect(subInsert.text).toMatch(/'trial'/);
    expect(subInsert.values).toContain(now);
    expect(subInsert.values.map(String)).toContain(
      new Date('2026-09-02T10:00:00.000Z').toString(),
    );
  });

  it('makes the signer the owner with the company as their default', async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);

    const membership = calls.find((c) => /INSERT INTO company_users/i.test(c.text))!;
    expect(membership.text).toMatch(/'owner'/);
    expect(membership.text).toMatch(/is_default/);
    expect(membership.values).toEqual(['company-1', 'user-1']);
  });

  it('persists undeclared turnover as NULL and denies PAYG', async () => {
    const { runner, calls } = fakeRunner();
    const result = await provisionTenant(
      runner,
      { ...baseInput, annualTurnoverCents: null },
      now,
    );

    expect(result.paygEligible).toBe(false);
    const companyInsert = calls.find((c) => /INSERT INTO companies/i.test(c.text))!;
    expect(companyInsert.values).toContain(null);
    expect(companyInsert.values).not.toContain(0);
  });

  it('marks a company over R1m as not PAYG eligible', async () => {
    const { runner } = fakeRunner();
    const result = await provisionTenant(
      runner,
      { ...baseInput, annualTurnoverCents: R1_2m },
      now,
    );
    expect(result.paygEligible).toBe(false);
    expect(result.suggestedPlanCode).toBe('starter');
  });

  it('still creates a usable tenant when the trial plan row is missing', async () => {
    const { runner, calls } = fakeRunner({ trialPlanExists: false });
    const result = await provisionTenant(runner, baseInput, now);

    expect(result.companyId).toBe('company-1');
    expect(result.subscriptionId).toBeNull();
    expect(calls.some((c) => /INSERT INTO subscriptions/i.test(c.text))).toBe(false);
    expect(calls.some((c) => /INSERT INTO company_users/i.test(c.text))).toBe(true);
  });
});

/**
 * A new tenant must get fiscal periods.
 *
 * Until this existed a freshly provisioned company had NONE, so every journal
 * date fell outside every period and posted with fiscal_period_id NULL —
 * invisible to the trial balance, the VAT201 and the AFS, because
 * postJournalEntry's closed-period check is guarded by `if (entry.fiscalPeriodId)`
 * and skips a NULL outright. Migration 501 records what that cost once already:
 * Britech's R267,109.70 salary understatement.
 */
describe('provisionTenant — fiscal periods', () => {
  const now = new Date('2026-08-19T10:00:00.000Z');

  it('creates twelve periods for the current year', async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);

    const periodInserts = calls.filter((c) => /INSERT INTO fiscal_periods/i.test(c.text));
    expect(periodInserts).toHaveLength(12);
    expect(periodInserts.every((c) => c.values[0] === 'company-1')).toBe(true);
  });

  it('covers the whole year with no gap, using the YEAR of the provisioning date', async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);

    const year = now.getFullYear();
    const periods = calls
      .filter((c) => /INSERT INTO fiscal_periods/i.test(c.text))
      .map((c) => ({ n: c.values[2] as number, start: c.values[4] as string, end: c.values[5] as string }))
      .sort((a, b) => a.n - b.n);

    expect(periods.map((p) => p.n)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
    expect(periods[0]!.start).toBe(`${year}-01-01`);
    expect(periods[11]!.end).toBe(`${year}-12-31`);
    // February's end date is computed, not assumed — a hardcoded 30 or 31 would
    // leave a day uncovered or overlap March, and overlapping periods are
    // refused outright by the fiscal_periods_no_overlap exclusion constraint.
    expect(periods[1]!.end).toBe(`${year}-02-${year % 4 === 0 ? '29' : '28'}`);
  });

  it('is idempotent, so re-provisioning cannot fail on the unique index', async () => {
    const { runner, calls } = fakeRunner();
    await provisionTenant(runner, baseInput, now);
    const insert = calls.find((c) => /INSERT INTO fiscal_periods/i.test(c.text))!;
    expect(insert.text).toMatch(/ON CONFLICT DO NOTHING/i);
  });
});
