/**
 * Pins the public surface of the Paystack client barrel (R-183). The file was
 * split by concern; `@/modules/billing/services/paystackClient` must keep
 * exporting exactly these runtime names and these type names. The type half is
 * enforced by `bun run type-check:paystack-exports` (vitest strips `import type`);
 * it checks that each type name is importable, plus the shape of three
 * VerifyTransactionResult fields, not the full shape of every type.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import type {
  ChargeAuthorizationInput,
  ChargeAuthorizationResult,
  CreatePlanInput,
  CreateSubscriptionInput,
  DisableSubscriptionInput,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaystackTransactionStatus,
  PlanResult,
  SubscriptionResult,
  VerifyTransactionResult,
} from '@/modules/billing/services/paystackClient';

// Captured from origin/master 1910c157b (unsplit file) before the split.
const PINNED_RUNTIME_EXPORTS = [
  'chargeAuthorization',
  'createPlan',
  'createSubscription',
  'disableSubscription',
  'initializeTransaction',
  'verifyTransaction',
];

describe('paystackClient — export surface', () => {
  it('runtime export names equal the pinned list', async () => {
    const mod = await import('@/modules/billing/services/paystackClient');
    expect(Object.keys(mod).sort()).toEqual(PINNED_RUNTIME_EXPORTS);
    for (const name of PINNED_RUNTIME_EXPORTS) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('every exported type name is importable', () => {
    const status: PaystackTransactionStatus = 'success';
    const init: InitializeTransactionInput = { email: 'a@b.co.za', amountCents: 1, reference: 'r' };
    const initRes: InitializeTransactionResult = { authorizationUrl: 'u', accessCode: 'a', reference: 'r' };
    const charge: ChargeAuthorizationInput = { authorizationCode: 'c', email: 'e', amountCents: 1, reference: 'r' };
    const chargeRes: ChargeAuthorizationResult = {
      status, reference: 'r', paystackId: null, amountCents: 1, gatewayResponse: null,
    };
    const plan: CreatePlanInput = { name: 'n', amountCents: 1, interval: 'monthly' };
    const planRes: PlanResult = { id: 1, planCode: 'p', name: 'n', amountCents: 1, interval: 'monthly' };
    const sub: CreateSubscriptionInput = { customer: 'c', planCode: 'p' };
    const subRes: SubscriptionResult = { id: 1, subscriptionCode: 's', emailToken: 't', status: 'active', amountCents: 1 };
    const dis: DisableSubscriptionInput = { subscriptionCode: 's', emailToken: 't' };
    const ver: Pick<VerifyTransactionResult, 'status' | 'requestedAmountCents' | 'feesCents'> = {
      status, requestedAmountCents: null, feesCents: null,
    };
    expect([init, initRes, charge, chargeRes, plan, planRes, sub, subRes, dis, ver]).toHaveLength(10);
  });
});
