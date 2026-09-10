/**
 * Unit tests for subscriptionBillingService — the generate-due-charges
 * and run-queued-charges state machine for recurring SaaS billing.
 *
 * Mocks: @/lib/neon.sql + paystackClient.chargeAuthorization. Each test
 * scripts a stack of sql responses in the order the service issues them.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { chargeAuthorization } from '@/modules/billing/services/paystackClient';
import {
  generateDueCharges,
  runQueuedCharges,
} from '@/modules/billing/services/subscriptionBillingService';

const mockSql = sql as unknown as MockedFunction<typeof sql>;
const mockCharge = chargeAuthorization as unknown as MockedFunction<typeof chargeAuthorization>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDueCharges', () => {
  it('creates one queued charge per due subscription and leaves the period alone', async () => {
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
      .mockResolvedValueOnce([{ id: 'mandate-1' }] as never) // active paystack mandate
      .mockResolvedValueOnce([] as never)          // INSERT charge
      .mockResolvedValueOnce([] as never)          // void charges of cancelling subs — none
      .mockResolvedValueOnce([] as never);         // close out cancelling subs — none

    const result = await generateDueCharges(now);

    expect(result).toEqual({ created: 1, skipped: 0, cancelled: 0, voided: 0 });
    expect(mockSql).toHaveBeenCalledTimes(6);
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
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await generateDueCharges(now);

    const insertCall = mockSql.mock.calls[3];
    const params = insertCall?.slice(1) ?? [];
    expect(params).toContain(8000); // 10000 * 0.8
  });

  it('skips when no active Paystack mandate exists', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql
      .mockResolvedValueOnce([{
        company_id: 'co-1', subscription_id: 'sub-1', plan_id: 'p',
        billing_cycle: 'monthly', current_period_start: '2026-04-01T00:00:00Z',
        current_period_end: '2026-05-01T00:00:00Z',
        discount_percent: 0, monthly_price_cents: 10000, annual_price_cents: 0,
      }] as never)
      .mockResolvedValueOnce([] as never)           // no existing charge
      .mockResolvedValueOnce([] as never)           // no active mandate
      .mockResolvedValueOnce([] as never)           // void — none
      .mockResolvedValueOnce([] as never);          // close out — none

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1, cancelled: 0, voided: 0 });
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
      .mockResolvedValueOnce([{ id: 'existing-charge' }] as never)
      .mockResolvedValueOnce([] as never)           // void — none
      .mockResolvedValueOnce([] as never);          // close out — none

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1, cancelled: 0, voided: 0 });
  });

  it('reports voided debits and closed-out subscriptions separately from skips', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql
      .mockResolvedValueOnce([] as never)                          // no due subs
      .mockResolvedValueOnce([{ id: 'charge-voided' }] as never)   // void
      .mockResolvedValueOnce([{ id: 'sub-cancelled' }] as never);  // close out

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 0, cancelled: 1, voided: 1 });
  });
});

describe('runQueuedCharges', () => {
  const baseCharge = {
    id: 'charge-1',
    company_id: 'co-1',
    mandate_id: 'mandate-1',
    amount_cents: '59900',
    paystack_reference: 'sub_co1_2026-05_abcd',
    external_reference: 'sub_co1_2026-05_abcd',
    attempt_count: 0,
    status: 'queued' as const,
    paystack_authorization_code: 'AUTH_xyz',
    paystack_customer_code: 'CUS_1',
    mandate_status: 'active',
    user_email: 'admin@acme.co.za',
    period_start: '2026-05-01',
  };

  it('charges the authorization and records a settled subscription_charges row on success', async () => {
    mockSql
      .mockResolvedValueOnce([baseCharge] as never)  // SELECT charges
      .mockResolvedValueOnce([{ count: 0 }] as never)         // unattributed live charges
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim the attempt
      .mockResolvedValueOnce([] as never)            // INSERT paystack_payment_requests
      .mockResolvedValueOnce([] as never)            // UPDATE charge → settled
      .mockResolvedValueOnce([] as never);           // advance the period

    mockCharge.mockResolvedValueOnce({
      status: 'success',
      reference: baseCharge.paystack_reference,
      paystackId: 12345,
      amountCents: 59900,
      gatewayResponse: 'Approved',
    });

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 1, failed: 0, skipped: 0 });
    expect(mockCharge).toHaveBeenCalledWith(expect.objectContaining({
      authorizationCode: 'AUTH_xyz',
      email: 'admin@acme.co.za',
      amountCents: 59900,
      reference: 'sub_co1_2026-05_abcd',
    }));
  });

  it('skips when mandate is not active', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...baseCharge, mandate_status: 'revoked' }] as never)
      .mockResolvedValueOnce([{ count: 0 }] as never)         // unattributed live charges
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it('skips when paystack_authorization_code is missing', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...baseCharge, paystack_authorization_code: null }] as never)
      .mockResolvedValueOnce([{ count: 0 }] as never)         // unattributed live charges
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never);

    const result = await runQueuedCharges();
    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it('marks charge failed when Paystack throws', async () => {
    mockSql
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([{ count: 0 }] as never)         // unattributed live charges
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed

    mockCharge.mockRejectedValueOnce(new Error('insufficient funds'));

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('does not charge when a concurrent run has already claimed the attempt', async () => {
    mockSql
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([{ count: 0 }] as never) // unattributed live charges
      .mockResolvedValueOnce([] as never); // claim matched no row

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });
});
