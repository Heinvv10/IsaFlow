/**
 * R-181 (PR #618 review at 72b132f52, M1): the webhook handler and the return page's verify route
 * hand recordGatewayInvoiceReceipt everything Paystack reported — amount, currency,
 * requested_amount and fees — and the fee leg. In CI: the database, the gateway and the receipt
 * service are mocked; the integration suites prove the same against Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: new Map<string, unknown[]>() }));
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    for (const [needle, rows] of h.rows) if (text.includes(needle)) return Promise.resolve(rows);
    return Promise.resolve([]);
  },
}));
vi.mock('@/modules/accounting/services/ar/gatewayInvoiceReceiptService', () => ({ recordGatewayInvoiceReceipt: vi.fn(async () => null) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({ completeBundlePurchase: vi.fn(), failBundlePurchase: vi.fn() }));
vi.mock('@/modules/billing/services/paystackMandateActivation', () => ({
  activateAuthorisedMandate: vi.fn(), noteAuthorisationNotAttached: vi.fn(), resolveAuthorisedMandate: vi.fn(),
}));
vi.mock('@/modules/billing/services/subscriptionPeriod', () => ({ settleSubscriptionCharge: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({ verifyTransaction: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '10.1.8.1' }));
vi.mock('@/lib/publicRouteTx', () => ({ withPublicRouteTransaction: (_l: string, fn: () => Promise<unknown>) => fn() }));

import { processEvent } from '@/modules/billing/services/paystackEventHandlers';
import { recordGatewayInvoiceReceipt } from '@/modules/accounting/services/ar/gatewayInvoiceReceiptService';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';
import verifyRoute from '../../../../pages/api/portal/payments/paystack/verify';

const record = recordGatewayInvoiceReceipt as unknown as ReturnType<typeof vi.fn>;
const verify = verifyTransaction as unknown as ReturnType<typeof vi.fn>;
const PR = { id: 'pr-1', company_id: 'co-1', purpose: 'customer_invoice', customer_invoice_id: 'inv-1', amount_cents: '11500' };
const REPORTED = { amountCents: 11850, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 };
const event = { event: 'charge.success', data: {
  reference: 'r181_pass', id: 1, amount: 11850, currency: 'ZAR', requested_amount: 11500, fees: 350, paid_at: '2026-10-02T10:00:00Z' } };

beforeEach(() => { h.rows.clear(); record.mockClear(); verify.mockReset(); });

describe('the webhook hands over what Paystack reported', () => {
  it('a pending request', async () => {
    h.rows.set('UPDATE paystack_payment_requests', [PR]);
    await processEvent('charge.success', event);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ requestedCents: 11500, reported: REPORTED, feeRand: 3.5 }));
  });

  it('a request already completed (verify got there first)', async () => {
    h.rows.set('FROM paystack_payment_requests', [PR]);
    await processEvent('charge.success', event);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ requestedCents: 11500, reported: REPORTED, feeRand: 3.5 }));
  });
});

describe('verify hands over what Paystack verified', () => {
  it('requested_amount and fees pass through, and the fee leg with them', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, paystack_reference: 'r181_pass', status: 'pending' }]);
    h.rows.set('UPDATE paystack_payment_requests', [{ id: 'pr-1' }]);
    verify.mockResolvedValue({ status: 'success', id: 1, amountCents: 11850, currency: 'ZAR',
      requestedAmountCents: 11500, feesCents: 350, paidAt: null, channel: 'card', authorization: null });
    const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
      status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; },
      setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, end() { return this; } };
    await verifyRoute({ method: 'GET', query: { ref: 'r181_pass' }, headers: {}, socket: {} } as never, res as never);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ requestedCents: 11500, reported: REPORTED, feeRand: 3.5 }));
  });
});
