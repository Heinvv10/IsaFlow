/**
 * Intercompany F: the accept body, the refusal ORDER (all from reads, before any write) and the fixed sentences. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_REFUSALS, judgeDraft, judgeExisting, parsePaymentAcceptBody, refusalOfReceiptCreate, stateSentence, type DraftFacts, type ExistingFacts,
} from '@/modules/accounting/services/intercompany/paymentAcceptRules';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

const U = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

describe('parsePaymentAcceptBody', () => {
  it('reads existing and draft bodies', () => {
    expect(parsePaymentAcceptBody({ outcome: 'existing', receiptId: U(1), expected: { amount: 1, state: 'open' } }).ok).toBe(true);
    expect(parsePaymentAcceptBody({
      outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-09-02', allocations: [{ invoiceId: U(3), amount: 1150 }],
      expected: { amount: 1150, state: 'open', invoiceIds: [U(3)] },
    }).ok).toBe(true);
  });
  it.each([
    ['no outcome', {}],
    ['an unknown outcome', { outcome: 'auto' }],
    ['a bad receipt id', { outcome: 'existing', receiptId: 'x', expected: { amount: 1, state: 'open' } }],
    ['no expected', { outcome: 'existing', receiptId: U(1) }],
    ['a bad date', { outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-02-30', allocations: [{ invoiceId: U(3), amount: 1 }], expected: { amount: 1, state: 'open', invoiceIds: [] } }],
    ['no allocations', { outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-09-02', allocations: [], expected: { amount: 1, state: 'open', invoiceIds: [] } }],
    ['a duplicate invoice', { outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-09-02', allocations: [{ invoiceId: U(3), amount: 1 }, { invoiceId: U(3), amount: 1 }], expected: { amount: 2, state: 'open', invoiceIds: [U(3)] } }],
    ['a non-number amount', { outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-09-02', allocations: [{ invoiceId: U(3), amount: '1' }], expected: { amount: 1, state: 'open', invoiceIds: [U(3)] } }],
  ])('refuses %s', (_n, body) => expect(parsePaymentAcceptBody(body).ok).toBe(false));
});

const existing = (over: Partial<ExistingFacts> = {}): ExistingFacts => ({
  expected: { amount: 1150, state: 'open' }, amount: 1150, state: 'open', candidate: true, unconsumedCents: 115000, ...over,
});
const draft = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  expected: { amount: 1150, state: 'open', invoiceIds: ['i1'] }, amount: 1150, state: 'open', offeredInvoiceIds: ['i1'], draftBlock: null,
  bankAccountOk: true, paymentDate: '2026-09-02', payloadDate: '2026-09-01', today: '2026-11-24',
  invoices: [{ id: 'i1', amountCents: 115000, wholeCents: true, own: true, customer: true, open: true, zar: true, onOrAfterCutover: true, openLessDraftsCents: 115000 }],
  dateRefusal: null, holderCount: 0, confirmNoHolder: false, ...over,
});

describe('judgeExisting / judgeDraft: the first refusal wins', () => {
  it('nothing for a good request', () => {
    expect(judgeExisting(existing())).toBeNull();
    expect(judgeDraft(draft())).toBeNull();
  });
  it('the state first, then what the person saw, then the receipt', () => {
    expect(judgeExisting(existing({ state: 'payer_gone', expected: { amount: 1, state: 'open' } }))).toBe('state');
    expect(judgeExisting(existing({ expected: { amount: 1, state: 'open' } }))).toBe('expected_mismatch');
    expect(judgeExisting(existing({ candidate: false, unconsumedCents: 0 }))).toBe('receipt_not_candidate');
    expect(judgeExisting(existing({ unconsumedCents: 114999 }))).toBe('receipt_short');
  });
  it('a draft: state, expected, exact candidate, bank account, invoices, amounts, dates, period', () => {
    const i = draft().invoices[0]!;
    const order: [string, Partial<DraftFacts>][] = [
      ['state', { state: 'link_gone' }],
      ['expected_mismatch', { offeredInvoiceIds: ['i1', 'i2'] }],
      ['draft_refused_exact', { draftBlock: 'exact_receipt' }],
      ['holder_unconfirmed', { holderCount: 1 }],
      ['bank_account', { bankAccountOk: false }],
      ['invoice_not_yours', { invoices: [{ ...i, own: false }] }],
      ['invoice_wrong_customer', { invoices: [{ ...i, customer: false }] }],
      ['invoice_not_open', { invoices: [{ ...i, open: false }] }],
      ['invoice_currency', { invoices: [{ ...i, zar: false }] }],
      ['pre_cutover_invoice', { invoices: [{ ...i, onOrAfterCutover: false }] }],
      ['amount_cents', { invoices: [{ ...i, wholeCents: false }] }],
      ['amount_sum', { invoices: [{ ...i, amountCents: 100000 }] }],
      ['exceeds_open', { invoices: [{ ...i, openLessDraftsCents: 100 }] }],
      ['date_before_payment', { paymentDate: '2026-08-31' }],
      ['date_after_today', { paymentDate: '2026-11-25' }],
      ['period_locked', { dateRefusal: 'period_locked' }],
    ];
    for (const [code, over] of order) expect(judgeDraft(draft(over)), code).toBe(code);
  });
  it('round 1 LOW-2: a receipt that may hold the payment needs the confirmation, naming the count the person saw', () => {
    expect(judgeDraft(draft({ holderCount: 2 }))).toBe('holder_unconfirmed');
    expect(judgeDraft(draft({ holderCount: 2, confirmNoHolder: true, expected: { amount: 1150, state: 'open', invoiceIds: ['i1'], holderCount: 1 } }))).toBe('expected_mismatch');
    expect(judgeDraft(draft({ holderCount: 2, confirmNoHolder: true, expected: { amount: 1150, state: 'open', invoiceIds: ['i1'], holderCount: 2 } }))).toBeNull();
    // a confirmation of holders that are gone is stale too
    expect(judgeDraft(draft({ holderCount: 0, confirmNoHolder: true, expected: { amount: 1150, state: 'open', invoiceIds: ['i1'], holderCount: 1 } }))).toBe('expected_mismatch');
    // a hard block (exact or linked candidate) is never lifted by the confirmation
    expect(judgeDraft(draft({ draftBlock: 'linked_receipt', holderCount: 1, confirmNoHolder: true, expected: { amount: 1150, state: 'open', invoiceIds: ['i1'], holderCount: 1 } }))).toBe('draft_refused_exact');
  });
  it('parses confirmNoHolder and expected.holderCount (the count is required with the confirmation)', () => {
    const body = { outcome: 'draft', bankAccountId: U(2), paymentDate: '2026-09-02', allocations: [{ invoiceId: U(3), amount: 1150 }],
      expected: { amount: 1150, state: 'open', invoiceIds: [U(3)], holderCount: 1 }, confirmNoHolder: true };
    const ok = parsePaymentAcceptBody(body);
    expect(ok.ok && ok.value.outcome === 'draft' && ok.value.confirmNoHolder && ok.value.expected.holderCount).toBe(1);
    expect(parsePaymentAcceptBody({ ...body, expected: { ...body.expected, holderCount: undefined } }).ok).toBe(false);
    expect(parsePaymentAcceptBody({ ...body, confirmNoHolder: 'yes' }).ok).toBe(false);
  });
  it('round 1 B2: a receipt create refusal is busy only when retryable, else its own sentence (never exceeds_open by default)', () => {
    expect(refusalOfReceiptCreate(new ReceiptRefusal('held', { held: true })).code).toBe('busy');
    const r = refusalOfReceiptCreate(new ReceiptRefusal('Allocations total R1.00 does not match payment R2.00'));
    expect(r.code).toBe('receipt_refused');
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/does not match payment/);
  });
  it('round 1: the new state words have sentences', () => {
    expect(stateSentence('not_cash')).toMatch(/cash/);
    expect(stateSentence('closed')).toMatch(/rejected|dismissed|handled/i);
  });
  it('every code has a status and a sentence that names no figure', () => {
    for (const [code, r] of Object.entries(PAYMENT_REFUSALS)) {
      expect([403, 404, 409, 422]).toContain(r.status);
      expect(r.sentence, code).not.toMatch(/\d{3,}/);
    }
    expect(stateSentence('payer_gone')).toMatch(/payer/i);
    expect(stateSentence('open')).toBe('');
  });
});
