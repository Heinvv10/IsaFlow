/**
 * A card payment must reach the ledger.
 *
 * `confirmCustomerPayment` is behind `requireControlTx`, and the two public
 * gateway entry points — the `charge.success` webhook and the portal return
 * page's verify fallback — both run under `withPublicRouteTransaction`, which
 * establishes no control principal. Every card payment therefore threw
 * 'Authenticated control transaction required': the webhook answered 500 and
 * Paystack retried forever, while verify SWALLOWED the throw and told the
 * customer "pending" with nothing recorded.
 *
 * These drive the REAL routes against a fake pg client and assert what the
 * customer is owed: the receipt is confirmed, under an explicit unattended
 * gateway principal — never a blank user id and never a borrowed person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'crypto';
import { pgTypesMock } from '../../helpers/pgTypesMock';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const REFERENCE = 'ps_ref_001';

const h = vi.hoisted(() => ({
  /** The principal `confirmCustomerPayment` saw, or the refusal it hit. */
  principal: null as { personId: string; companyId: string; authMethod: string; provenance: string } | null,
  refusal: null as string | null,
  confirmedBy: null as string | null,
  banked: [] as Array<Record<string, unknown>>,
  existingPayment: [] as Array<Record<string, unknown>>,
}));

const query = vi.fn(async (text: string, values?: unknown[]) => {
  const sql = String(text);
  if (/INSERT INTO paystack_webhook_events/i.test(sql)) return { rows: [{ id: 'evt-1' }] };
  if (/SELECT processed FROM paystack_webhook_events/i.test(sql)) return { rows: [{ processed: false }] };
  if (/UPDATE paystack_payment_requests/i.test(sql)) {
    return { rows: [{ id: 'pr-1', company_id: COMPANY, purpose: 'customer_invoice',
      customer_invoice_id: INVOICE, flow_purchase_id: null, subscription_charge_id: null,
      mandate_id: null, amount_cents: '50000', status: 'completed' }] };
  }
  if (/FROM paystack_payment_requests/i.test(sql)) {
    return { rows: [{ id: 'pr-1', company_id: COMPANY, customer_invoice_id: INVOICE,
      paystack_reference: REFERENCE, amount_cents: '50000', status: 'pending',
      invoice_number: 'INV-1', invoice_total: '500.00', invoice_amount_paid: '0',
      company_name: 'Acme' }] };
  }
  if (/FROM customer_payments/i.test(sql)) return { rows: h.existingPayment };
  if (/FROM customer_invoices/i.test(sql)) {
    return { rows: [{ client_id: CLIENT, created_by: MEMBER, total_amount: '500.00', amount_paid: '0' }] };
  }
  if (/FROM customer_payment_allocations/i.test(sql)) return { rows: [{ pending: '0' }] };
  if (/FROM company_users/i.test(sql)) return { rows: [{ user_id: MEMBER }] };
  if (/INSERT INTO customer_payments/i.test(sql)) {
    h.banked.push({ createdBy: values?.[values.length - 1] });
    return { rows: [] };
  }
  return { rows: [] };
});
const client = { query, release: vi.fn() };
vi.mock('pg', () => {
  class Pool { connect = async () => client; query = query; on = vi.fn(); end = vi.fn(); }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/logger', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: async () => true, getClientIp: () => '1.2.3.4' }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: async () => ({ status: 'success', id: 99, paidAt: '2026-09-10T10:00:00Z', channel: 'card' }),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: async () => ({ id: '55555555-5555-4555-8555-555555555555' }),
}));
vi.mock('@/modules/accounting/services/ar/gatewayFeeService', () => ({ postGatewayFee: async () => undefined }));

/**
 * The real gate, at the real call site: `requireArControl` is what
 * `confirmCustomerPayment` runs first, and it refuses both a missing control
 * transaction and a principal that is not the actor the caller named.
 */
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  confirmCustomerPayment: async (companyId: string, id: string, userId: string) => {
    const { requireArControl } = await import('@/modules/accounting/services/ar/arControlBoundary');
    try {
      h.principal = (requireArControl(companyId, userId) as { principal: typeof h.principal }).principal;
      h.confirmedBy = userId;
    } catch (error) { h.refusal = error instanceof Error ? error.message : String(error); throw error; }
    return { id, glJournalEntryId: 'je-1' };
  },
}));

import webhookHandler from '../../../../pages/api/webhooks/paystack';
import verifyHandler from '../../../../pages/api/portal/payments/paystack/verify';

function res() {
  return { statusCode: 200, payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
    setHeader() { return this; }, end() { return this; } };
}

/** The webhook reads a raw body stream and checks the HMAC before anything else. */
function webhookReq(body: string) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req = { method: 'POST', headers: {
    'x-paystack-signature': createHmac('sha512', 'sk_test', ).update(body).digest('hex') },
    on(event: string, fn: (chunk?: unknown) => void) { (listeners[event] ??= []).push(fn); return this; } };
  queueMicrotask(() => {
    listeners.data?.forEach(fn => fn(Buffer.from(body, 'utf-8')));
    listeners.end?.forEach(fn => fn());
  });
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.principal = null; h.refusal = null; h.confirmedBy = null; h.banked = []; h.existingPayment = [];
  process.env.PAYSTACK_SECRET_KEY = 'sk_test';
});

describe('gateway receipts reach the controlled AR posting', () => {
  it('records the receipt for a charge.success webhook', async () => {
    const body = JSON.stringify({ event: 'charge.success',
      data: { reference: REFERENCE, amount: 50000, paid_at: '2026-09-10T10:00:00Z', fees: 725 } });
    const r = res();
    await webhookHandler(webhookReq(body) as never, r as never);
    expect(h.refusal).toBeNull();
    expect(r.statusCode).toBe(200);
    expect(h.principal).toMatchObject({ companyId: COMPANY });
  });

  it('records the receipt for the portal verify fallback, which swallows its own errors', async () => {
    const r = res();
    await verifyHandler({ method: 'GET', query: { ref: REFERENCE }, headers: {}, socket: {} } as never, r as never);
    expect(h.refusal).toBeNull();
    expect(h.principal).toMatchObject({ companyId: COMPANY });
    expect((r.payload as { data?: { status?: string } })?.data?.status).toBe('completed');
  });

  it('attributes the receipt to an explicit unattended gateway principal, not a person and not a blank id', async () => {
    const r = res();
    await verifyHandler({ method: 'GET', query: { ref: REFERENCE }, headers: {}, socket: {} } as never, r as never);
    expect(h.principal?.authMethod).toBe('gateway');
    expect(h.principal?.provenance).toBe('gateway');
    expect(h.principal?.personId).toBeTruthy();
    expect(h.principal?.personId).not.toBe(MEMBER);
    expect(h.confirmedBy).toBe(h.principal?.personId);
    expect(h.banked[0]?.createdBy).toBe(h.principal?.personId);
  });
});

/** The gateway principal is for THIS path only: nothing else may mint one. */
describe('the gateway principal is not a general-purpose bypass', () => {
  it('refuses any controlled operation other than the customer payment receipt', async () => {
    const { assertGatewayReceiptOperation } = await import(
      '@/modules/accounting/services/controls/gatewayReceiptConfinement');
    const principal = { authMethod: 'gateway', companyId: COMPANY } as never;
    expect(() => assertGatewayReceiptOperation({ principal } as never,
      { entityType: 'customer_payment', entityId: 'p', operation: 'customer_payment.confirm' })).not.toThrow();
    for (const ref of [
      { entityType: 'customer_payment', entityId: 'p', operation: 'customer_payment.cancel' } as const,
      { entityType: 'journal', entityId: 'j', operation: 'journal.post' } as const,
      { entityType: 'supplier_payment', entityId: 's', operation: 'supplier_payment.process' } as const,
    ]) {
      expect(() => assertGatewayReceiptOperation({ principal } as never, ref)).toThrow(/gateway/i);
    }
  });

  it('refuses to mint a gateway principal through the authenticated factory', async () => {
    const { makeControlPrincipal } = await import('@/modules/accounting/services/controls/context');
    expect(() => makeControlPrincipal({ personId: MEMBER, companyId: COMPANY, authMethod: 'gateway' as never }))
      .toThrow(/Authenticated tenant principal required/);
  });
});
