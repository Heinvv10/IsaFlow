/**
 * Intercompany P4-E, the pure rules of the payer's "Clear against the intercompany loan": the request body (the preview's keys only), "what
 * is approved is what posts" (loan account, link, amount, the bill's open amount), the refusal table (a fixed sentence and an HTTP status per
 * code: no figure, no id, never database text) and the receiver-readiness words the definer may answer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYER_CLEAR_SENTENCES, PAYER_CLEAR_STATUS, R035_SENTENCE, RECEIVER_READY_REASONS, parseLoanClearBody, payerExpectedMismatch, payerRefusal,
} from '@/modules/accounting/services/intercompany/payerLoanClearRefusals';
import { PayerClearRefusal, type PayerClearCode } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const BILL = 'b0000000-0000-4000-8000-000000000001';
const LOAN = 'a0000000-0000-4000-8000-000000000001';
const LINK = 'c0000000-0000-4000-8000-000000000001';
const AP = 'd0000000-0000-4000-8000-000000000001';
const body = (over: Record<string, unknown> = {}, expected: Record<string, unknown> = {}) => ({
  billId: BILL, amount: 400, postingDate: '2026-09-10', expected: { loanAccountId: LOAN, linkId: LINK, amount: 400, openAmount: 1150, payableAccountId: AP, ...expected }, ...over,
});

describe('parseLoanClearBody', () => {
  it('takes the bill, the amount, the date and what the preview showed; ids lower-cased', () => {
    const r = parseLoanClearBody(body({ billId: BILL.toUpperCase() }, { loanAccountId: LOAN.toUpperCase(), payableAccountId: AP.toUpperCase() }));
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
    ['no expected AP control (J)', body({}, { payableAccountId: undefined })], ['an AP control that is no UUID', body({}, { payableAccountId: 'ap' })],
  ])('refuses %s', (_name, b) => {
    expect(parseLoanClearBody(b).ok).toBe(false);
  });
});

describe('payerExpectedMismatch (what is approved is what posts)', () => {
  const read = { loanAccountId: LOAN, linkId: LINK, openAmount: 1150, payableAccountId: AP };
  const input = (expected: Record<string, unknown> = {}, amount = 400) => ({
    amount, expected: { loanAccountId: LOAN, linkId: LINK, amount: 400, openAmount: 1150, payableAccountId: AP, ...expected },
  });
  it('nothing differs: null (case of the ids ignored, the amounts to the cent)', () => {
    expect(payerExpectedMismatch(input({ loanAccountId: LOAN.toUpperCase(), linkId: LINK.toUpperCase(), payableAccountId: AP.toUpperCase() }), read)).toBeNull();
    expect(payerExpectedMismatch(input({ openAmount: 1150.001 }), read)).toBeNull();
  });
  it('the first that differs: loan account, link, amount (the request against the preview), open amount', () => {
    expect(payerExpectedMismatch(input({ loanAccountId: LINK, linkId: LOAN, openAmount: 1 }), read)).toBe('loan_account');
    expect(payerExpectedMismatch(input({ linkId: LOAN, openAmount: 1 }), read)).toBe('link');
    expect(payerExpectedMismatch(input({ amount: 500, openAmount: 1 }), read)).toBe('amount');
    expect(payerExpectedMismatch(input({ openAmount: 1000 }), read)).toBe('open_amount');
    expect(payerExpectedMismatch(input({}), { ...read, loanAccountId: null })).toBe('loan_account');
    // J: the AP control approved is the one the books name now (and a chart without one never matches)
    expect(payerExpectedMismatch(input({ payableAccountId: LOAN }), read)).toBe('payable_account');
    expect(payerExpectedMismatch(input({}), { ...read, payableAccountId: null })).toBe('payable_account');
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
    // round 3 (a): the amount can be the cause (exceeds_open): a generic hint, never the partner's open amount
    expect(PAYER_CLEAR_SENTENCES.receiver_not_ready).toMatch(/Check with the partner, or try a smaller amount\./);
    expect(PAYER_CLEAR_SENTENCES.receiver_not_ready).not.toMatch(/\d/);
  });
  it('the readiness words are exactly the words the definer (migration 1029) can RETURN, both ways', () => {
    const migration = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/1029_intercompany_p4e_receiver_readiness.sql'), 'utf8');
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.intercompany_receiver_loan_ready');
    const body = migration.slice(start, migration.indexOf('$$;', migration.indexOf('AS $$', start)));
    const returned = new Set([...body.matchAll(/RETURN '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(returned.size).toBeGreaterThan(5);
    expect([...RECEIVER_READY_REASONS].sort()).toEqual([...returned].sort());
    // and no other RETURN can answer something else (a computed word would escape the list)
    expect(body.match(/\bRETURN\b(?! ')/g) ?? []).toEqual([]);
  });
});
