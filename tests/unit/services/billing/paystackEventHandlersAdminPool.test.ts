/**
 * S-07e (migration 945): the Paystack webhook's writes to the billing tables
 * (flow purchases, subscription charges, mandates) run on the migration_admin
 * pool; its own tables (paystack_payment_requests) stay on the event's
 * transaction. The payment request's status change is issued FIRST, so a
 * migration_admin write that commits is always one a redelivery repeats.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  adminValues: [] as unknown[][],
  script: [] as unknown[][],
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    h.order.push(/UPDATE paystack_payment_requests/.test(text) ? 'app:payment_request' : 'app:other');
    return h.script.shift() ?? [];
  }),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminSqlTx: async (label: string, fn: (tx: unknown) => Promise<unknown>) => {
    h.order.push(`admin:${label}`);
    return fn(async (_s: TemplateStringsArray, ...values: unknown[]) => { h.adminValues.push(values); return []; });
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/gatewayInvoiceReceiptService', () => ({ recordGatewayInvoiceReceipt: vi.fn() }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  completePaidBundlePurchase: vi.fn(async () => ({ purchaseId: 'fp-1', balanceAfter: 10 })),
  failBundlePurchase: vi.fn(async () => undefined),
}));
vi.mock('@/modules/billing/services/subscriptionPeriod', () => ({ settleSubscriptionCharge: vi.fn(async () => undefined) }));
vi.mock('@/modules/billing/services/paystackMandateActivation', () => ({
  activateAuthorisedMandate: vi.fn(),
  noteAuthorisationNotAttached: vi.fn(),
  resolveAuthorisedMandate: vi.fn(),
}));

import { completePaidBundlePurchase, failBundlePurchase } from '@/modules/billing/services/flowWalletService';
import { settleSubscriptionCharge } from '@/modules/billing/services/subscriptionPeriod';
import { noteAuthorisationNotAttached } from '@/modules/billing/services/paystackMandateActivation';
import { processEvent } from '@/modules/billing/services/paystackEventHandlers';

beforeEach(() => {
  h.order.length = 0;
  h.adminValues.length = 0;
  h.script.length = 0;
  vi.clearAllMocks();
});

const PR = { id: 'pr-1', company_id: 'co-1', flow_purchase_id: null, subscription_charge_id: null,
  customer_invoice_id: null, mandate_id: null, amount_cents: '100', status: 'completed' };
// The checkout metadata Paystack signs: the server set it from the verified request.
const META = { flow: { company_id: 'co-1', flow_purchase_id: 'fp-1' }, charge: { company_id: 'co-1', subscription_charge_id: 'ch-1' } };

describe('Paystack webhook handlers', () => {
  it('subscription.disable revokes the mandate on the migration_admin pool, by the subscription code', async () => {
    await processEvent('subscription.disable', { event: 'subscription.disable', data: { subscription_code: 'SUB_9' } });
    expect(h.order).toEqual(['admin:paystack_subscription_disabled']);
    expect(h.adminValues).toEqual([['SUB_9']]);
  });

  it('charge.failed on a subscription charge: the payment request first, then the charge on migration_admin', async () => {
    h.script.push([{ id: 'pr-1', company_id: 'co-1', purpose: 'subscription_charge', flow_purchase_id: null,
      subscription_charge_id: 'ch-1', mandate_id: null }]);
    await processEvent('charge.failed', { event: 'charge.failed', data: { reference: 'ref-1', metadata: META.charge } });
    expect(h.order).toEqual(['app:payment_request', 'admin:paystack_charge_failed']);
    // Scoped to the payment request's company: its charge link is app-written (S-07e).
    expect(h.adminValues).toEqual([['charge.failed', 'ch-1', 'co-1']]);
  });

  it('charge.failed on a flow purchase fails the purchase, and writes no subscription charge', async () => {
    h.script.push([{ id: 'pr-1', company_id: 'co-1', purpose: 'flow_bundle', flow_purchase_id: 'fp-1',
      subscription_charge_id: null, mandate_id: null }]);
    await processEvent('charge.failed', { event: 'charge.failed', data: { reference: 'ref-1', metadata: META.flow } });
    expect(failBundlePurchase).toHaveBeenCalledWith('fp-1', 'co-1', 'charge.failed');
    expect(h.order).toEqual(['app:payment_request']);
  });

  it.each([
    ['no metadata', undefined],
    ['another company\'s', { company_id: 'co-2', subscription_charge_id: 'ch-1' }],
    ['another charge', { company_id: 'co-1', subscription_charge_id: 'ch-2' }],
  ])('charge.failed whose checkout metadata is %s fails only the request', async (_, metadata) => {
    h.script.push([{ id: 'pr-1', company_id: 'co-1', purpose: 'subscription_charge', flow_purchase_id: null,
      subscription_charge_id: 'ch-1', mandate_id: null }]);
    await processEvent('charge.failed', { event: 'charge.failed', data: { reference: 'ref-1', metadata } });
    expect(h.order).toEqual(['app:payment_request']);
    expect(h.adminValues).toEqual([]);
  });

  it('a redelivered charge.failed (request already failed) writes nothing', async () => {
    h.script.push([]);
    await processEvent('charge.failed', { event: 'charge.failed', data: { reference: 'ref-1' } });
    expect(h.order).toEqual(['app:payment_request']);
    expect(failBundlePurchase).not.toHaveBeenCalled();
  });

  it('charge.success on a flow bundle completes the purchase after the request is marked completed', async () => {
    h.script.push([{ ...PR, purpose: 'flow_bundle', flow_purchase_id: 'fp-1' }]);
    await processEvent('charge.success', { event: 'charge.success', data: { reference: 'ref-1', amount: 10150, requested_amount: 10000,
      currency: 'ZAR', metadata: META.flow } });
    expect(h.order).toEqual(['app:payment_request']);
    // Bound to what the checkout asked for (the payer's fee on top excluded) and to the request's company.
    expect(completePaidBundlePurchase).toHaveBeenCalledWith('fp-1', { companyId: 'co-1', amountCents: 10000, currency: 'ZAR' });
  });

  it.each([
    ['no metadata', undefined],
    ['another company\'s', { company_id: 'co-2', flow_purchase_id: 'fp-1' }],
    ['another purchase', { company_id: 'co-1', flow_purchase_id: 'fp-2' }],
  ])('charge.success whose checkout metadata is %s credits nothing and marks the request for review', async (_, metadata) => {
    h.script.push([{ ...PR, purpose: 'flow_bundle', flow_purchase_id: 'fp-1' }]);
    await processEvent('charge.success', { event: 'charge.success', data: { reference: 'ref-1', amount: 10000, currency: 'ZAR',
      metadata } });
    expect(completePaidBundlePurchase).not.toHaveBeenCalled();
    expect(noteAuthorisationNotAttached).toHaveBeenCalledWith('pr-1', 'co-1', expect.stringMatching(/^review:/));
  });

  it('charge.success on a subscription charge settles it for the amount and currency Paystack reported', async () => {
    h.script.push([{ ...PR, purpose: 'subscription_charge', subscription_charge_id: 'ch-1' }]);
    await processEvent('charge.success', { event: 'charge.success', data: { reference: 'ref-1', amount: 49900, currency: 'ZAR',
      metadata: META.charge } });
    expect(settleSubscriptionCharge).toHaveBeenCalledWith('ch-1', 'co-1', { cents: 49900, currency: 'ZAR' });
  });
});
