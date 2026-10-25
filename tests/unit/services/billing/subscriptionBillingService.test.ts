/**
 * Unit tests for subscriptionBillingService — the generate-due-charges
 * and run-queued-charges state machine for recurring SaaS billing.
 *
 * Mocks: @/lib/neon.sql (the app pool: reads), the migration_admin tx
 * (S-07e: every write to subscription_charges, and the read of the mandate's
 * card codes) + paystackClient.chargeAuthorization. Each test scripts a stack
 * of responses per pool in the order the service issues them; a statement sent
 * to the wrong pool finds an empty script and fails the test.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/migrationAdminPool', () => {
  const tx = vi.fn();
  return { migrationAdminSqlTx: vi.fn(async (_label: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)), __tx: tx };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: vi.fn(),
}));

import { sql } from '@/lib/neon';
import * as adminPool from '@/lib/auth/migrationAdminPool';
import { chargeAuthorization } from '@/modules/billing/services/paystackClient';
import {
  generateDueCharges,
  runQueuedCharges,
} from '@/modules/billing/services/subscriptionBillingService';

const mockSql = sql as unknown as MockedFunction<typeof sql>;
const mockAdmin = (adminPool as unknown as { __tx: MockedFunction<typeof sql> }).__tx;
const adminLabels = () =>
  (adminPool.migrationAdminSqlTx as unknown as MockedFunction<(l: string) => unknown>).mock.calls.map((c) => c[0]);
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
      .mockResolvedValueOnce([{ id: 'mandate-1' }] as never); // active paystack mandate
    mockAdmin
      .mockResolvedValueOnce([] as never)          // INSERT charge
      .mockResolvedValueOnce([] as never)          // void charges of cancelling subs — none
      .mockResolvedValueOnce([] as never);         // close out cancelling subs — none

    const result = await generateDueCharges(now);

    expect(result).toEqual({ created: 1, skipped: 0, cancelled: 0, voided: 0 });
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(adminLabels()).toEqual(['subscription_queue_charge', 'subscription_void_charges', 'subscription_close_out']);
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
      .mockResolvedValueOnce([{ id: 'm-1' }] as never);
    mockAdmin
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await generateDueCharges(now);

    const insertCall = mockAdmin.mock.calls[0];
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
      .mockResolvedValueOnce([] as never);          // no active mandate
    mockAdmin
      .mockResolvedValueOnce([] as never)           // void — none
      .mockResolvedValueOnce([] as never);          // close out — none

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1, cancelled: 0, voided: 0 });
    expect(adminLabels()).toEqual(['subscription_void_charges', 'subscription_close_out']);
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
    mockAdmin
      .mockResolvedValueOnce([] as never)           // void — none
      .mockResolvedValueOnce([] as never);          // close out — none

    const result = await generateDueCharges(now);
    expect(result).toEqual({ created: 0, skipped: 1, cancelled: 0, voided: 0 });
  });

  it('reports voided debits and closed-out subscriptions separately from skips', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    mockSql.mockResolvedValueOnce([] as never);                    // no due subs
    mockAdmin
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
    // The SELECT reads the mandate's card codes, so it is the migration_admin pool's.
    mockAdmin
      .mockResolvedValueOnce([baseCharge] as never)  // SELECT charges
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim the attempt
      .mockResolvedValueOnce([] as never)            // UPDATE charge → settled
      .mockResolvedValueOnce([] as never);           // advance the period
    mockSql
      .mockResolvedValueOnce([{ count: 0 }] as never)         // unattributed live charges
      .mockResolvedValueOnce([] as never);           // INSERT paystack_payment_requests

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
    expect(adminLabels()).toEqual([
      'subscription_due_charges', 'subscription_claim_attempt',
      'subscription_charge_submitted', 'subscription_advance_period',
    ]);
  });

  it('skips when mandate is not active', async () => {
    mockAdmin
      .mockResolvedValueOnce([{ ...baseCharge, mandate_status: 'revoked' }] as never)
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed (past-due is not reached below 3 attempts)
    mockSql.mockResolvedValueOnce([{ count: 0 }] as never); // unattributed live charges

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it('skips when paystack_authorization_code is missing', async () => {
    mockAdmin
      .mockResolvedValueOnce([{ ...baseCharge, paystack_authorization_code: null }] as never)
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never);
    mockSql.mockResolvedValueOnce([{ count: 0 }] as never); // unattributed live charges

    const result = await runQueuedCharges();
    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it('marks charge failed when Paystack throws', async () => {
    mockAdmin
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([{ attempt_count: 1 }] as never) // claim
      .mockResolvedValueOnce([] as never); // UPDATE charge → failed
    mockSql.mockResolvedValueOnce([{ count: 0 }] as never); // unattributed live charges

    mockCharge.mockRejectedValueOnce(new Error('insufficient funds'));

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('does not charge when a concurrent run has already claimed the attempt', async () => {
    mockAdmin
      .mockResolvedValueOnce([baseCharge] as never)
      .mockResolvedValueOnce([] as never); // claim matched no row
    mockSql.mockResolvedValueOnce([{ count: 0 }] as never); // unattributed live charges

    const result = await runQueuedCharges();

    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 1 });
    expect(mockCharge).not.toHaveBeenCalled();
  });
});
