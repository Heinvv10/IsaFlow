/**
 * Intercompany P4-D, the pure rules of the receiver's clearing: the Accept body (the preview's keys only), "what is approved is what posts", what
 * an error under the savepoint counts as (a receipt refusal is busy only when it is retryable), the loan-account classes (never a system
 * account), and the sentence table (fixed, generic: no figure, no id, never database text). The caps are the definer's (round 1, F2).
 */
import { describe, expect, it } from 'vitest';
import {
  CLEAR_REFUSAL_SENTENCES, MISMATCH_SENTENCE, expectedMismatch, isLoanClass, isRealDate, parseAcceptBody, refusalOfCode,
} from '@/modules/accounting/services/intercompany/allocationClearRefusals';
import type { ClearRefusalCode } from '@/modules/accounting/services/intercompany/allocationClearTypes';

const LOAN = 'a0000000-0000-4000-8000-000000000001';
const INV = 'e0000000-0000-4000-8000-000000000001';
const body = (over: Record<string, unknown> = {}) => ({ expectedLoanAccountId: LOAN, invoiceId: INV, amount: 1150, postingDate: '2026-09-01', ...over });

describe('parseAcceptBody', () => {
  it('takes the four fields the preview sent, ids lower-cased', () => {
    expect(parseAcceptBody(body({ expectedLoanAccountId: LOAN.toUpperCase() }))).toEqual({ ok: true, value: { ...body(), expectedLoanAccountId: LOAN } });
  });
  it.each([
    ['no body', null], ['an array', []], ['no loan account', body({ expectedLoanAccountId: undefined })], ['a loan account that is no UUID', body({ expectedLoanAccountId: 'x' })],
    ['no invoice', body({ invoiceId: undefined })], ['an amount as text', body({ amount: '1150' })], ['a zero amount', body({ amount: 0 })],
    ['a negative amount', body({ amount: -1 })], ['a fraction of a cent', body({ amount: 11.505 })], ['an infinite amount', body({ amount: Infinity })],
    ['an extra key', body({ approverUserId: LOAN })], ['no posting date', body({ postingDate: undefined })], ['a date that does not exist', body({ postingDate: '2026-02-30' })], ['a timestamp', body({ postingDate: '2026-09-01T00:00:00Z' })],
  ])('refuses %s', (_name, b) => {
    expect(parseAcceptBody(b).ok).toBe(false);
  });
  it('isRealDate: calendar dates only', () => {
    expect([isRealDate('2028-02-29'), isRealDate('2026-02-29'), isRealDate('2026-13-01'), isRealDate('26-01-01')]).toEqual([true, false, false, false]);
  });
});

describe('expectedMismatch (what is approved is what posts)', () => {
  const read = { loanAccountId: LOAN, invoiceId: INV, amount: 1150 };
  it('nothing differs: null (case of the ids ignored, the amount to the cent)', () => {
    expect(expectedMismatch({ ...body(), expectedLoanAccountId: LOAN.toUpperCase() }, read)).toBeNull();
    expect(expectedMismatch(body({ amount: 1150.001 }) as never, read)).toBeNull();
  });
  it('the first that differs, loan account before invoice before amount, each with its sentence', () => {
    expect(expectedMismatch(body({ expectedLoanAccountId: INV, invoiceId: LOAN, amount: 1 }) as never, read)).toBe('loan_account');
    expect(expectedMismatch(body({ invoiceId: LOAN, amount: 1 }) as never, read)).toBe('invoice');
    expect(expectedMismatch(body({ amount: 1149.99 }) as never, read)).toBe('amount');
    for (const s of Object.values(MISMATCH_SENTENCE)) expect(s).toMatch(/Nothing was posted/);
  });
});

describe('refusalOfCode (an error under the savepoint)', () => {
  it.each([
    ['CUSTOMER_INVOICE_LOCK_TIMEOUT', 'busy'], ['ROW_LOCK_TIMEOUT', 'busy'], ['55P03', 'busy'], ['40P01', 'busy'],
    ['VAT_PERIOD_LOCKED', 'vat_locked'], ['CONTRA_SETTLEMENT_REFUSED', 'refused'], ['APPROVE_PERMISSION_REFUSED', 'forbidden'],
  ])('%s -> %s', (code, want) => {
    expect(refusalOfCode(code)).toBe(want);
  });
  it('a receipt refusal is busy only when it is retryable (a held row, contention); any other receipt refusal is refused', () => {
    expect(refusalOfCode('RECEIPT_REFUSED', { retryable: true })).toBe('busy');
    expect(refusalOfCode('RECEIPT_REFUSED', { retryable: false })).toBe('refused');
    expect(refusalOfCode('RECEIPT_REFUSED')).toBe('refused');
  });

  it('a contra refusal or a missing system account is refused; the approver check stays forbidden even then', () => {
    expect(refusalOfCode(null, { contraRefusal: true })).toBe('refused');
    expect(refusalOfCode(null, { missingSystemAccount: true })).toBe('refused');
    expect(refusalOfCode('APPROVE_PERMISSION_REFUSED', { contraRefusal: true })).toBe('forbidden');
  });
  it('anything else is not a refusal: a codeless error, a driver code, a constraint, a statement timeout', () => {
    for (const code of [null, '23514', '23505', '57014', 'XX000']) expect(refusalOfCode(code)).toBeNull();
  });
});

describe('isLoanClass (by type and subtype, never by name)', () => {
  it('a loan or intercompany balance-sheet position', () => {
    for (const [t, s] of [['asset', 'other_current_asset'], ['asset', 'other'], ['liability', 'other_current_liability'], ['liability', 'long_term_liability'], ['liability', 'current_liability'], ['liability', 'other']]) {
      expect([t, s, isLoanClass(t!, s!, false)]).toEqual([t, s, true]);
      expect([t, s, 'system', isLoanClass(t!, s!, true)]).toEqual([t, s, 'system', false]);
    }
  });
  it('an account type that is no own key of the class table (constructor, __proto__, toString) is no loan class, and never throws', () => {
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect([t, isLoanClass(t, 'other', false)]).toEqual([t, false]);
  });

  it('never a control, bank, cash, VAT, tax, payroll, stock, fixed asset, equity or P&L account, nor one without a subtype', () => {
    for (const [t, s] of [['asset', 'receivable'], ['asset', 'bank'], ['asset', 'cash'], ['asset', 'vat_input'], ['asset', 'inventory'], ['asset', 'fixed_asset'],
      ['liability', 'payable'], ['liability', 'vat_output'], ['liability', 'tax'], ['liability', 'payroll_liability'], ['equity', 'equity'], ['equity', 'other'],
      ['revenue', 'other'], ['expense', 'other'], ['asset', null], [null, 'other']]) {
      expect([t, s, isLoanClass(t, s, false)]).toEqual([t, s, false]);
    }
  });
});

describe('the sentence table', () => {
  const codes: ClearRefusalCode[] = ['malformed', 'not_live', 'no_loan_account', 'loan_account_unusable', 'invoice_gone', 'invoice_not_open', 'wrong_customer', 'currency',
    'pre_cutover_invoice', 'pre_cutover_payment', 'exceeds_open', 'cash_not_through_loan', 'already_cleared', 'no_period', 'period_locked', 'vat_locked', 'busy', 'refused',
    'not_group', 'loan_class_mismatch'];
  it('one fixed sentence per refusal, each saying nothing was posted, with no figure, id or database word', () => {
    expect(Object.keys(CLEAR_REFUSAL_SENTENCES).sort()).toEqual([...codes].sort());
    for (const c of codes) {
      const s = CLEAR_REFUSAL_SENTENCES[c];
      expect([c, /Nothing was posted\.$/.test(s), /\d/.test(s), /[0-9a-f]{8}-|SQL|constraint|violat|null/i.test(s), s.length <= 500]).toEqual([c, true, false, false, true]);
    }
    expect(CLEAR_REFUSAL_SENTENCES.cash_not_through_loan).toMatch(/clear it by matching the bank receipt/);
    expect(CLEAR_REFUSAL_SENTENCES.already_cleared).toMatch(/already cleared/);
  });
});
