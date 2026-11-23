/**
 * Intercompany P4-C: the receiver's reading of an `allocation` payload (`parseMirrorPayload(raw, 'allocation', sender)`). The database built it
 * (1025) but the receiver still treats it as untrusted input: strict on the fields it shows or acts on (version, kind, ids are UUIDs, money is
 * finite, positive and 2 dp, the two documents are of the right types), unknown keys ignored.
 */
import { describe, expect, it } from 'vitest';
import { parseMirrorPayload } from '@/modules/accounting/services/intercompany/mirrorPayload';

const SENDER = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

const payload = (over: Record<string, unknown> = {}) => ({
  version: 1, kind: 'allocation', allocationId: id(2), amount: 1150, currency: 'zar',
  payment: { id: id(3), number: 'SP-00012', reference: 'IC alloc ref', date: '2026-09-01', method: 'eft', cashLegIsLoanAccount: false },
  payerDocument: { type: 'supplier_invoice', id: id(4), number: 'BILL-7' },
  issuerDocument: { type: 'customer_invoice', id: id(5) },
  linkId: id(6), linkOrigin: 'manual_pairing',
  ...over,
});
const parse = (raw: unknown) => parseMirrorPayload(raw, 'allocation', SENDER);
const error = (raw: unknown) => { const r = parse(raw); return r.ok ? null : r.error; };

describe('a valid allocation payload', () => {
  it('reads every field, the currency upper-cased', () => {
    const r = parse(payload());
    expect(r).toEqual({
      ok: true,
      payload: {
        version: 1, kind: 'allocation', allocationId: id(2), amount: 1150, currency: 'ZAR',
        payment: { id: id(3), number: 'SP-00012', reference: 'IC alloc ref', date: '2026-09-01', method: 'eft', cashLegIsLoanAccount: false },
        payerDocument: { type: 'supplier_invoice', id: id(4), number: 'BILL-7' },
        issuerDocument: { type: 'customer_invoice', id: id(5) },
        linkId: id(6), linkOrigin: 'manual_pairing',
      },
    });
  });

  it('ignores unknown keys, at the top and inside the parts', () => {
    const r = parse(payload({ extra: 'x', payment: { ...payload().payment, extra: 1 }, issuerDocument: { type: 'customer_invoice', id: id(5), number: 'INV-1' } }));
    expect(r.ok).toBe(true);
    expect(r.ok && 'extra' in r.payload).toBe(false);
    expect(r.ok && r.payload.issuerDocument).toEqual({ type: 'customer_invoice', id: id(5) });
  });

  it('takes a payment with no number, reference or method, and a bill with no number (the sender cleans empty text to null)', () => {
    const r = parse(payload({ payment: { ...payload().payment, number: null, reference: null, method: null }, payerDocument: { type: 'supplier_invoice', id: id(4), number: null } }));
    expect(r.ok).toBe(true);
  });

  it('takes cents and the loan-account flag', () => {
    const r = parse(payload({ amount: 0.01, payment: { ...payload().payment, cashLegIsLoanAccount: true } }));
    expect(r.ok && [r.payload.amount, r.payload.payment.cashLegIsLoanAccount]).toEqual([0.01, true]);
  });
});

describe('a malformed allocation payload is refused with a sentence', () => {
  const pay = (over: Record<string, unknown>) => payload({ payment: { ...payload().payment, ...over } });
  it.each<[string, unknown]>([
    ['not an object', 'x'],
    ['an array', []],
    ['a newer version', payload({ version: 2 })],
    ['another kind', payload({ kind: 'invoice' })],
    ['no allocation id', payload({ allocationId: undefined })],
    ['an allocation id that is not a UUID', payload({ allocationId: 'abc' })],
    ['a string amount', payload({ amount: '1150' })],
    ['a zero amount', payload({ amount: 0 })],
    ['a negative amount', payload({ amount: -5 })],
    ['an infinite amount', payload({ amount: Infinity })],
    ['NaN', payload({ amount: Number.NaN })],
    ['a third decimal', payload({ amount: 10.005 })],
    ['an absurd amount', payload({ amount: 1e13 })],
    ['no currency', payload({ currency: undefined })],
    ['a currency of four letters', payload({ currency: 'ZARR' })],
    ['no payment', payload({ payment: undefined })],
    ['a payment id that is not a UUID', pay({ id: 'p-1' })],
    ['a payment date that is no date', pay({ date: '2026-02-30' })],
    ['a payment number that is too long', pay({ number: 'x'.repeat(51) })],
    ['a reference that is too long', pay({ reference: 'x'.repeat(256) })],
    ['a method that is too long', pay({ method: 'x'.repeat(21) })],
    ['a loan-account flag that is not a boolean', pay({ cashLegIsLoanAccount: 'yes' })],
    ['a payer document of another type', payload({ payerDocument: { type: 'customer_invoice', id: id(4), number: 'B' } })],
    ['a payer document id that is not a UUID', payload({ payerDocument: { type: 'supplier_invoice', id: 'b', number: 'B' } })],
    ['an issuer document of another type', payload({ issuerDocument: { type: 'supplier_invoice', id: id(5) } })],
    ['an issuer document id that is not a UUID', payload({ issuerDocument: { type: 'customer_invoice', id: 7 } })],
    ['no issuer document', payload({ issuerDocument: null })],
    ['a link id that is not a UUID', payload({ linkId: 'l' })],
    ['no link origin', payload({ linkOrigin: '' })],
  ])('%s', (_name, raw) => {
    expect(error(raw)).toEqual(expect.any(String));
  });
});

describe('the document kinds are unchanged', () => {
  it('an allocation payload read as an invoice is refused (its kind does not match)', () => {
    expect(parseMirrorPayload(payload(), 'invoice', SENDER)).toEqual({ ok: false, error: 'The message does not match its kind' });
  });
});
