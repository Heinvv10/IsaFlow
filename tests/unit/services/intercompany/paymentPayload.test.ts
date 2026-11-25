/**
 * Intercompany F: the receiver reads a `payment` payload (built by `intercompany_send_for_payment`, migration 1031) as untrusted input: strict
 * on what it shows or acts on (ids are uuids, money whole cents and positive, dates real, text bounded), unknown keys ignored.
 */
import { describe, expect, it } from 'vitest';
import { parsePaymentPayload } from '@/modules/accounting/services/intercompany/paymentPayload';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const U5 = '55555555-5555-4555-8555-555555555555';
const good = () => ({
  version: 1, kind: 'payment', allocationId: U1, amount: 1150, currency: 'zar',
  payment: { id: U2, number: 'SP-1', reference: 'ref', date: '2026-09-01', method: 'eft' },
  payerDocument: { type: 'supplier_invoice', id: U3, number: 'B-1', date: '2026-08-01' },
  issuerDocument: { type: 'customer_invoice', id: U4 }, linkId: U5, extra: 'ignored',
});

describe('parsePaymentPayload', () => {
  it('reads a good payload, upper-casing the currency and dropping unknown keys', () => {
    const r = parsePaymentPayload(good());
    expect(r).toEqual({ ok: true, payload: {
      version: 1, kind: 'payment', allocationId: U1, amount: 1150, currency: 'ZAR',
      payment: { id: U2, number: 'SP-1', reference: 'ref', date: '2026-09-01', method: 'eft' },
      payerDocument: { type: 'supplier_invoice', id: U3, number: 'B-1', date: '2026-08-01' },
      issuerDocument: { type: 'customer_invoice', id: U4 }, linkId: U5,
    } });
  });

  it('allows a null payment number, reference, method, bill number and bill date', () => {
    const p = good();
    Object.assign(p.payment, { number: null, reference: null, method: null });
    Object.assign(p.payerDocument, { number: null, date: null });
    expect(parsePaymentPayload(p).ok).toBe(true);
  });

  it.each([
    ['not an object', () => 'x'],
    ['another version', () => ({ ...good(), version: 2 })],
    ['another kind', () => ({ ...good(), kind: 'allocation' })],
    ['a bad allocation id', () => ({ ...good(), allocationId: 'x' })],
    ['a zero amount', () => ({ ...good(), amount: 0 })],
    ['a negative amount', () => ({ ...good(), amount: -1 })],
    ['a third decimal', () => ({ ...good(), amount: 1.005 })],
    ['a string amount', () => ({ ...good(), amount: '1150' })],
    ['no currency', () => ({ ...good(), currency: 'ZA' })],
    ['a bad payment id', () => ({ ...good(), payment: { ...good().payment, id: 'nope' } })],
    ['an unreal payment date', () => ({ ...good(), payment: { ...good().payment, date: '2026-02-30' } })],
    ['a long payment number', () => ({ ...good(), payment: { ...good().payment, number: 'x'.repeat(51) } })],
    ['a bill of the wrong type', () => ({ ...good(), payerDocument: { ...good().payerDocument, type: 'customer_invoice' } })],
    ['an unreal bill date', () => ({ ...good(), payerDocument: { ...good().payerDocument, date: '2026-13-01' } })],
    ['an issuer document of the wrong type', () => ({ ...good(), issuerDocument: { type: 'supplier_invoice', id: U4 } })],
    ['a bad link id', () => ({ ...good(), linkId: 'x' })],
  ])('refuses %s', (_name, make) => {
    const r = parsePaymentPayload(make());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
