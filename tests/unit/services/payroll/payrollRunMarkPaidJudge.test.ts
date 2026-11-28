/**
 * Wave 7 MP (W27, Hein ruling 16): the typed path of "Mark paid" needs a bank payment reference (1-64 characters after
 * trimming) and a real payment date, both or neither; the date lies between the approval day and today (SAST).
 * The pure judges; the database path is tests/integration/w7-mp-mark-paid.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PAID_REFERENCE, PayrollRunMarkPaidRefusal, judgePaidOnWindow, parseTypedPayment,
} from '@/modules/accounting/services/payroll/payrollRunMarkPaidJudge';

const refusal = (fn: () => unknown): PayrollRunMarkPaidRefusal => {
  try { fn(); } catch (err) { if (err instanceof PayrollRunMarkPaidRefusal) return err; throw err; }
  throw new Error('expected a refusal');
};

describe('parseTypedPayment', () => {
  it('neither field: the file path (null)', () => {
    expect(parseTypedPayment({})).toBeNull();
    expect(parseTypedPayment({ reference: null, paidOn: null })).toBeNull();
  });

  it('both: the trimmed reference and the date', () => {
    expect(parseTypedPayment({ reference: '  EFT 2026-11 salaries ', paidOn: '2026-11-25' }))
      .toEqual({ reference: 'EFT 2026-11 salaries', paidOn: '2026-11-25' });
  });

  it.each([
    ['blank', ''], ['whitespace only', ' \t  '], ['missing (date only)', undefined],
  ])('a %s reference is refused (400 INVALID_REFERENCE)', (_l, reference) => {
    const r = refusal(() => parseTypedPayment({ reference, paidOn: '2026-11-25' }));
    expect([r.status, r.reason]).toEqual([400, 'INVALID_REFERENCE']);
  });

  it.each([
    ['a control character', 'EFT\u00071'], ['a bidi override', 'EFT\u202E1'], ['a zero-width space', 'EFT\u200B1'],
    ['a line separator', 'EFT\u20281'], ['a newline inside', 'EFT\n1'],
  ])('S1: %s in the reference is refused (400 INVALID_REFERENCE)', (_l, reference) => {
    const r = refusal(() => parseTypedPayment({ reference, paidOn: '2026-11-25' }));
    expect([r.status, r.reason]).toEqual([400, 'INVALID_REFERENCE']);
    expect(r.message).toMatch(/invisible or control character/);
  });

  it('S1: ordinary punctuation, accents and spaces inside pass', () => {
    expect(parseTypedPayment({ reference: 'FNB/EFT-2026 #12 Zoë', paidOn: '2026-11-25' })?.reference).toBe('FNB/EFT-2026 #12 Zoë');
  });

  it(`${MAX_PAID_REFERENCE} characters pass; one more is refused`, () => {
    expect(parseTypedPayment({ reference: 'R'.repeat(MAX_PAID_REFERENCE), paidOn: '2026-11-25' })?.reference).toHaveLength(64);
    expect(refusal(() => parseTypedPayment({ reference: 'R'.repeat(MAX_PAID_REFERENCE + 1), paidOn: '2026-11-25' })).reason)
      .toBe('INVALID_REFERENCE');
  });

  it.each([['missing', undefined], ['not a date', '25/11/2026'], ['not a real day', '2026-02-30'], ['empty', '']])(
    'a %s payment date is refused (400 INVALID_PAID_ON)', (_l, paidOn) => {
      const r = refusal(() => parseTypedPayment({ reference: 'EFT1', paidOn }));
      expect([r.status, r.reason]).toEqual([400, 'INVALID_PAID_ON']);
    });
});

describe('judgePaidOnWindow (approval day .. today, inclusive)', () => {
  it('the approval day and today both pass', () => {
    expect(() => judgePaidOnWindow('2026-11-20', '2026-11-20', '2026-11-25')).not.toThrow();
    expect(() => judgePaidOnWindow('2026-11-25', '2026-11-20', '2026-11-25')).not.toThrow();
  });

  it('a day before the approval is refused, naming both dates', () => {
    const r = refusal(() => judgePaidOnWindow('2026-11-19', '2026-11-20', '2026-11-25'));
    expect([r.status, r.reason]).toEqual([400, 'INVALID_PAID_ON']);
    expect(r.message).toMatch(/2026-11-19 is before the run was approved \(2026-11-20\)/);
  });

  it('tomorrow is refused', () => {
    const r = refusal(() => judgePaidOnWindow('2026-11-26', '2026-11-20', '2026-11-25'));
    expect(r.reason).toBe('INVALID_PAID_ON');
    expect(r.message).toMatch(/in the future/);
  });
});
