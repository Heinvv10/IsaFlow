/**
 * Intercompany P4-E, the pure rules of the payer's "Clear against the intercompany loan": the request body (the preview's keys only), "what
 * is approved is what posts" (loan account, link, amount, the bill's open amount), the refusal table (a fixed sentence and an HTTP status per
 * code: no figure, no id, never database text) and the receiver-readiness words the definer may answer.
 */
import { describe, expect, it } from 'vitest';
import {
  PAYER_CLEAR_SENTENCES, PAYER_CLEAR_STATUS, R035_SENTENCE, RECEIVER_READY_REASONS, parseLoanClearBody, payerExpectedMismatch, payerRefusal,
} from '@/modules/accounting/services/intercompany/payerLoanClearRefusals';
import { PayerClearRefusal, type PayerClearCode } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const BILL = 'b0000000-0000-4000-8000-000000000001';
const LOAN = 'a0000000-0000-4000-8000-000000000001';
const LINK = 'c0000000-0000-4000-8000-000000000001';
const body = (over: Record<string, unknown> = {}, expected: Record<string, unknown> = {}) => ({
  billId: BILL, amount: 400, postingDate: '2026-09-10', expected: { loanAccountId: LOAN, linkId: LINK, amount: 400, openAmount: 1150, ...expected }, ...over,
});

describe('parseLoanClearBody', () => {
  it('takes the bill, the amount, the date and what the preview showed; ids lower-cased', () => {
    const r = parseLoanClearBody(body({ billId: BILL.toUpperCase() }, { loanAccountId: LOAN.toUpperCase() }));
    expect(r).toEqual({ ok: true, value: body() });
  });
  it.each([
    ['no body', null], ['an array', []], ['an extra key', body({ approverUserId: LOAN })], ['an extra expected key', body({}, { userId: LOAN })],
    ['no bill', body({ billId: undefined })], ['a bill that is no UUID', body({ billId: 'x' })], ['no expected', body({ expected: undefined })],
    ['an expected link that is no UUID', body({}, { linkId: 'x' })], ['an expected loan account that is no UUID', body({}, { loanAccountId: 1 })],
    ['an amount as text', body({ amount: '400' })], ['a zero amount', body({ amount: 0 })], ['a negative amount', body({ amount: -1 })],
    ['a fraction of a cent', body({ amount: 11.505 })], ['an infinite amount', body({ amount: Infinity })],
    ['an expected amount in fractions of a cent', body({}, { amount: 1.001 })], ['a negative open amount', body({}, { openAmount: -1 })],
    ['an open amount as text', body({}, { openAmount: '1150' })], ['no posting date', body({ postingDate: undefined })],
    ['a date that does not exist', body({ postingDate: '2026-02-30' })], ['a timestamp', body({ postingDate: '2026-09-01T00:00:00Z' })],
  ])('refuses %s', (_name, b) => {
    expect(parseLoanClearBody(b).ok).toBe(false);
  });
});

describe('payerExpectedMismatch (what is approved is what posts)', () => {
  const read = { loanAccountId: LOAN, linkId: LINK, openAmount: 1150 };
  const input = (expected: Record<string, unknown> = {}, amount = 400) => ({ amount, expected: { loanAccountId: LOAN, linkId: LINK, amount: 400, openAmount: 1150, ...expected } });
  it('nothing differs: null (case of the ids ignored, the amounts to the cent)', () => {
    expect(payerExpectedMismatch(input({ loanAccountId: LOAN.toUpperCase(), linkId: LINK.toUpperCase() }), read)).toBeNull();
    expect(payerExpectedMismatch(input({ openAmount: 1150.001 }), read)).toBeNull();
  });
  it('the first that differs: loan account, link, amount (the request against the preview), open amount', () => {
    expect(payerExpectedMismatch(input({ loanAccountId: LINK, linkId: LOAN, openAmount: 1 }), read)).toBe('loan_account');
    expect(payerExpectedMismatch(input({ linkId: LOAN, openAmount: 1 }), read)).toBe('link');
    expect(payerExpectedMismatch(input({ amount: 500, openAmount: 1 }), read)).toBe('amount');
    expect(payerExpectedMismatch(input({ openAmount: 1000 }), read)).toBe('open_amount');
    expect(payerExpectedMismatch(input({}), { ...read, loanAccountId: null })).toBe('loan_account');
  });
});

describe('the refusal table', () => {
  const codes = Object.keys(PAYER_CLEAR_SENTENCES) as PayerClearCode[];
  it('every code has a sentence and a status; the sentence names no id, no figure and says nothing was posted', () => {
    for (const code of codes) {
      const s = PAYER_CLEAR_SENTENCES[code];
      expect(s.length, code).toBeGreaterThan(20);
      expect(s, code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(s, code).not.toMatch(/R\s?\d/);
      expect([400, 403, 404, 409], code).toContain(PAYER_CLEAR_STATUS[code]);
    }
  });
  it('the statuses: the person 403, the bill 404, the dates 400, the books 409', () => {
    expect(PAYER_CLEAR_STATUS.no_write_role).toBe(403);
    expect(PAYER_CLEAR_STATUS.no_approve).toBe(403);
    expect(PAYER_CLEAR_STATUS.not_own_session).toBe(403);
    expect(PAYER_CLEAR_STATUS.bill_not_found).toBe(404);
    expect(PAYER_CLEAR_STATUS.date_before_bill).toBe(400);
    expect(PAYER_CLEAR_STATUS.period_locked).toBe(400);
    expect(PAYER_CLEAR_STATUS.no_link).toBe(409);
    expect(PAYER_CLEAR_STATUS.receiver_not_ready).toBe(409);
    expect(PAYER_CLEAR_STATUS.stale).toBe(409);
  });
  it('payerRefusal: a ConnectionRefusal (the routes answer it) carrying its code, status and sentence', () => {
    const r = payerRefusal('no_link');
    expect(r).toBeInstanceOf(PayerClearRefusal);
    expect(r).toBeInstanceOf(ConnectionRefusal);
    expect([r.code, r.status, r.message]).toEqual(['no_link', 409, PAYER_CLEAR_SENTENCES.no_link]);
    expect(payerRefusal('bill_not_found').message).toMatch(/ not found$/);
  });
  it('R-035 and the receiver are plain, generic sentences', () => {
    expect(R035_SENTENCE).toMatch(/an approval rule applies to payments of this size: use the normal payment route/);
    expect(PAYER_CLEAR_SENTENCES.approval_rule).toBe(R035_SENTENCE);
    expect(PAYER_CLEAR_SENTENCES.receiver_not_ready).toMatch(/partner/i);
  });
  it('the readiness words the definer may answer', () => {
    expect([...RECEIVER_READY_REASONS].sort()).toEqual([
      'currency', 'exceeds_open', 'invoice_gone', 'invoice_not_open', 'invoice_pre_cutover', 'loan_class_mismatch', 'not_found', 'ready',
      'receiver_flag_off', 'receiver_loan_not_set_up', 'wrong_customer',
    ]);
  });
});
