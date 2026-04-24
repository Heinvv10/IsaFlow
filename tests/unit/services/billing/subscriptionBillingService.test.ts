/**
 * Unit tests for subscriptionBillingService — the generate-due-charges
 * and run-queued-charges state machine that drives recurring LinkPay debits.
 *
 * Mocks: @/lib/neon.sql + stitchClient.debitFromMandate. Each test script
 * a stack of sql responses in the order the service issues them.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/billing/services/stitchClient', () => ({
  debitFromMandate: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { debitFromMandate } from '@/modules/billing/services/stitchClient';
import {
  generateDueCharges,
  runQueuedCharges,
} from '@/modules/billing/services/subscriptionBillingService';

const mockSql = sql as unknown as MockedFunction<typeof sql>;
const mockDebit = debitFromMandate as unknown as MockedFunction<typeof debitFromMandate>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDueCharges', () => {
  it('creates one queued charge per due subscription and rolls the period forward', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const due = {
      company_id: 'co-1',
      subscription_id: 'sub-1',
      plan_id: 'plan-pro',
      billing_cycle: 'monthly' as const,
      current_period_start: '2026-04-01T00:00:00Z',
      current_period_end: '2026-05-01T00:00:00Z',
      discount_percent: 0,
      monthly_price_cents: 59900,
      annual_price_cents: 599000,
    };

    mockSql
      .mockResolvedValueOnce([due] as never)       // SELECT due subs
      .mockResolvedValueOnce([] as never)          // existing charge check — none
      .mockResolvedValueOnce([{ id: 'mandate-1' }] as never) // active mandate
      .mockResolvedValueOnce([] as never)          // INSERT charge
      .mockResolvedValueOnce([] as never);         // UPDATE subscription period

    const result = await generateDueCharges(now);

    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('applies discount_percent to the charge amount', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql
      .mockResolvedValueOnce([{
        company_id: 'co-1', subscription_id: 'sub-1', plan_id: 'p',
        billing_cycle: 'monthly', current_period_start: '2026-04-01T00:00:00Z',
        current_period_end: '2026-05-01T00:00:00Z',
        discount_percent: 20, monthly_price_cents: 10000, annual_price_cents: 0,
      }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'm-1' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await generateDueCharges(now);

    const insertCall = mockSql.mock.calls[3];
    const params = insertCall?.slice(1) ?? [];
    expect(params).toContain(8000); // 10000 * 0.8
  });

  it('skips when no active mandate exists', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql
      .mockResolvedValueOnce([{
        company_id: 'co-1', subscription_id: 'sub-1', plan_id: 'p',
        billing_cycle: 'monthly', current_period_start: '2026-04-01T00:00:00Z',
        current_period_end: '2026-05-01T00:00:00Z',
        discount_percent: 0, monthly_price_cents: 10000, annual_price_cents: 0,
      }] as never)
      .mockResolvedValueOnce([] as never)           // no existing charge
      .mockResolvedValueOnce([] as never);          // no active mandate

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1 });
  });

  it('skips when a charge already exists for the period', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql
      .mockResolvedValueOnce([{
        company_id: 'co-1', subscription_id: 'sub-1', plan_id: 'p',
        billing_cycle: 'monthly', current_period_start: '2026-04-01T00:00:00Z',
        current_period_end: '2026-05-01T00:00:00Z',
        discount_percent: 0, monthly_price_cents: 10000, annual_price_cents: 0,
      }] as never)
      .mockResolvedValueOnce([{ id: 'existing-charge' }] as never);

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1 });
  });
});

describe('runQueuedCharges', () => {
  const baseCharge = {
    id: 'charge-1',
    company_id: 'co-1',
    mandate_id: 'mandate-1',
    amount_cents: '59900',
    external_reference: 'sub_co-1_2026-05_abcd',
    attempt_count: 0,
    status: 'queued' as const,
    stitch_bank_account_id: 'bank-1',
    mandate_status: 'active',
    company_name: 'Acme Pty Ltd',
    period_start: '2026-05-01',
  };

  it('fails queued charges until Stitch Express recurring is enabled', async () => {
    // debitFromMandate currently throws a "not enabled" error on every call
    // while we wait on Stitch Express to upgrade the tenant scope.
    mockSql
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed

    mockDebit.mockRejectedValueOnce(new Error('Stitch Express recurring not enabled on this tenant.'));

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
    expect(mockDebit).toHaveBeenCalledWith(expect.objectContaining({
      bankAccountId: 'bank-1',
      amountCents: 59900,
      externalReference: 'sub_co-1_2026-05_abcd',
    }));
  });

  it('marks charge failed with mandate_not_active when mandate is not active', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...baseCharge, mandate_status: 'revoked' }] as never)
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('marks charge failed when Stitch throws', async () => {
    mockSql
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed

    mockDebit.mockRejectedValueOnce(new Error('insufficient funds'));

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });
});
