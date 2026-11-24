/**
 * planDueCharges: the read-only half of generateDueCharges. Every due
 * subscription gets exactly one outcome, so the cron (and its dry run) can say
 * which subscriptions are billed, skipped, or left unbilled for want of a
 * mandate. Mocks @/lib/neon.sql only: the planner writes nothing.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminSqlTx: vi.fn() }));

import { sql } from '@/lib/neon';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { planDueCharges } from '@/modules/billing/services/subscriptionChargePlan';

const mockSql = sql as unknown as MockedFunction<typeof sql>;
const NOW = new Date('2026-05-11T00:00:00Z');
const due = (over: Record<string, unknown> = {}) => ({
  company_id: 'co-1', subscription_id: 'sub-1', plan_id: 'p',
  billing_cycle: 'monthly', current_period_start: '2026-04-01T00:00:00Z',
  current_period_end: new Date('2026-05-01T00:00:00Z'),
  discount_percent: 0, monthly_price_cents: 10000, annual_price_cents: 100000, ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('planDueCharges', () => {
  it('plans a charge for the next period at the discounted price when a mandate is active', async () => {
    mockSql
      .mockResolvedValueOnce([due({ discount_percent: 20 })] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'm-1' }] as never);

    const [item, ...rest] = await planDueCharges(NOW);

    expect(rest).toEqual([]);
    expect(item).toEqual({
      outcome: 'create', companyId: 'co-1', subscriptionId: 'sub-1', mandateId: 'm-1',
      periodStart: '2026-05-01', periodEnd: '2026-06-01', amountCents: 8000,
      currentPeriodEnd: '2026-05-01T00:00:00.000Z', daysOverdue: 10,
    });
    expect(migrationAdminSqlTx).not.toHaveBeenCalled();
  });

  it('plans an annual cycle a year ahead at the annual price', async () => {
    mockSql
      .mockResolvedValueOnce([due({ billing_cycle: 'annual' })] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'm-1' }] as never);
    const [item] = await planDueCharges(NOW);
    expect(item).toMatchObject({ outcome: 'create', periodEnd: '2027-05-01', amountCents: 100000 });
  });

  it('marks a paid subscription with no active Paystack mandate unbilled_no_mandate', async () => {
    mockSql
      .mockResolvedValueOnce([due()] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    const [item] = await planDueCharges(NOW);
    expect(item).toMatchObject({ outcome: 'unbilled_no_mandate', mandateId: null, amountCents: 10000, daysOverdue: 10 });
  });

  it('skips a free plan without reading charges or mandates', async () => {
    mockSql.mockResolvedValueOnce([due({ monthly_price_cents: 0 })] as never);
    const [item] = await planDueCharges(NOW);
    expect(item).toMatchObject({ outcome: 'skip_zero_amount', amountCents: 0 });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('skips a period that already has a charge, before the mandate check', async () => {
    mockSql
      .mockResolvedValueOnce([due()] as never)
      .mockResolvedValueOnce([{ id: 'c-1' }] as never);
    const [item] = await planDueCharges(NOW);
    expect(item).toMatchObject({ outcome: 'skip_existing', mandateId: null });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
