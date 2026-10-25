/**
 * R-181 (PR #618 review at 6a46d8417, M2): what the return page's verify route tells the payer, in
 * CI. A request swept to `failed` that Paystack says succeeded, whose settlement then throws, must
 * answer `pending` (never "failed", which invites a second payment); a settled payment answers with
 * what was banked, whether the invoice took it, and the currency it was reported in. The database,
 * the gateway and the receipt service are mocked.
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
vi.mock('@/modules/billing/services/paystackClient', () => ({ verifyTransaction: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: () => '10.1.8.2' }));
vi.mock('@/lib/publicRouteTx', () => ({ withPublicRouteTransaction: (_l: string, fn: () => Promise<unknown>) => fn() }));

import verifyRoute from '../../../../pages/api/portal/payments/paystack/verify';
import { recordGatewayInvoiceReceipt } from '@/modules/accounting/services/ar/gatewayInvoiceReceiptService';
import { verifyTransaction } from '@/modules/billing/services/paystackClient';

const record = recordGatewayInvoiceReceipt as unknown as ReturnType<typeof vi.fn>;
const verify = verifyTransaction as unknown as ReturnType<typeof vi.fn>;
const PR = { id: 'pr-1', company_id: 'co-1', purpose: 'customer_invoice', customer_invoice_id: 'inv-1',
  paystack_reference: 'r181_verify', amount_cents: '11500', invoice_number: 'INV-1', company_name: 'R181 Co' };

async function call(): Promise<{ statusCode: number; body: { data?: Record<string, unknown> } }> {
  const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, end() { return this; } };
  await verifyRoute({ method: 'GET', query: { ref: 'r181_verify' }, headers: {}, socket: {} } as never, res as never);
  return res as never;
}

beforeEach(() => { h.rows.clear(); record.mockReset(); record.mockResolvedValue(null); verify.mockReset(); });

describe('verify: a charged payer is never told "failed"', () => {
  it('a request stored failed, Paystack success, the settlement throws: pending', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'failed' }]);
    h.rows.set('UPDATE paystack_payment_requests', [{ id: 'pr-1' }]);
    verify.mockResolvedValue({ status: 'success', id: 1, amountCents: 11500, currency: 'ZAR', paidAt: null, channel: 'card', authorization: null, metadata: { company_id: 'co-1', invoice_id: 'inv-1' } });
    record.mockRejectedValue(new Error('Invoice inv-1 is being processed by another request — retry in a moment.'));
    expect((await call()).body.data).toMatchObject({ status: 'pending' });
  });

  it('a request stored failed whose live check throws (timeout, 5xx) answers pending, not failed', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'failed' }]);
    verify.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    expect((await call()).body.data).toMatchObject({ status: 'pending' });
  });

  it('a request stored failed that Paystack still reports pending answers pending', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'failed' }]);
    verify.mockResolvedValue({ status: 'pending', id: 1, amountCents: 11500, currency: 'ZAR', paidAt: null, channel: 'card', authorization: null, metadata: { company_id: 'co-1', invoice_id: 'inv-1' } });
    expect((await call()).body.data).toMatchObject({ status: 'pending' });
  });

  it('a request stored failed that Paystack reports reversed stays failed', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'failed' }]);
    verify.mockResolvedValue({ status: 'reversed', id: 1, amountCents: 11500, currency: 'ZAR', paidAt: null, channel: 'card', authorization: null, metadata: { company_id: 'co-1', invoice_id: 'inv-1' } });
    expect((await call()).body.data).toMatchObject({ status: 'failed' });
  });

  it('a request stored failed that Paystack also says failed stays failed', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'failed' }]);
    verify.mockResolvedValue({ status: 'failed', id: 1, amountCents: 11500, currency: 'ZAR', paidAt: null, channel: 'card', authorization: null, metadata: { company_id: 'co-1', invoice_id: 'inv-1' } });
    expect((await call()).body.data).toMatchObject({ status: 'failed' });
  });
});

describe('verify: a settled payment answers with what was banked', () => {
  it('R50 banked and applied, in ZAR', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'completed' }]);
    h.rows.set('FROM customer_payments cp', [{ total: '50.00', applied: '50.00', description: 'Paystack card payment r181_verify' }]);
    expect((await call()).body.data).toMatchObject({ status: 'completed', amountCents: 5000, appliedToInvoice: true, currency: 'ZAR' });
  });

  it('one cent applied is applied', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'completed' }]);
    h.rows.set('FROM customer_payments cp', [{ total: '115.00', applied: '0.01', description: 'Paystack card payment r181_verify' }]);
    expect((await call()).body.data).toMatchObject({ appliedToInvoice: true });
  });

  it('banked in USD and held unapplied', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'completed' }]);
    h.rows.set('FROM customer_payments cp', [{ total: '115.00', applied: '0',
      description: 'Paystack card payment r181_verify (USD 115.00 reported, booked as ZAR)' }]);
    expect((await call()).body.data).toMatchObject({ status: 'completed', amountCents: 11500, appliedToInvoice: false, currency: 'USD' });
  });

  it('nothing banked yet: the checkout amount, not applied, ZAR', async () => {
    h.rows.set('FROM paystack_payment_requests pr', [{ ...PR, status: 'pending' }]);
    verify.mockResolvedValue({ status: 'pending', id: 1, amountCents: 11500, currency: 'ZAR', paidAt: null, channel: 'card', authorization: null, metadata: { company_id: 'co-1', invoice_id: 'inv-1' } });
    expect((await call()).body.data).toMatchObject({ status: 'pending', amountCents: 11500, appliedToInvoice: false, currency: 'ZAR' });
  });
});
