/**
 * brk-nrfd HIGH (pre-existing): a journal line with debit/credit NaN passed every rule (NaN compares false), Postgres
 * numeric stores 'NaN', and trg_gl_je_balanced let the entry post (NaN = NaN): the touched balances became NaN.
 * validateJournalLine — run by createJournalEntry AND postJournalEntry — now refuses a non-finite amount.
 */
import { describe, expect, it } from 'vitest';
import { validateJournalEntry, validateJournalLine } from '@/modules/accounting/utils/doubleEntry';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const line = (debit: unknown, credit: unknown) => ({ glAccountId: A, debit, credit }) as never;

describe('journal lines refuse non-finite amounts', () => {
  it.each([
    [NaN, NaN], [NaN, 0], [0, NaN], ['NaN', 'NaN'], [Infinity, 0], [0, -Infinity], ['Infinity', 0], ['abc', 0],
    // rev-nrfd round 2: Number() reads these as finite, Postgres numeric refuses them.
    ['', 10], [' ', 10], [[], 10], [true, 0], ['0x10', 0],
  ])('debit %j credit %j is refused', (debit, credit) => {
    expect(validateJournalLine(line(debit, credit))).toEqual({ valid: false, error: 'Debit and credit must be numbers' });
  });

  it('a NaN pair (the attack: balanced only because NaN = NaN in SQL) fails the entry', () => {
    const r = validateJournalEntry([line(NaN, NaN), { glAccountId: B, debit: NaN, credit: NaN } as never]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/must be numbers/);
  });

  // brk-nrfd round 2 LOW: text amounts concatenated in the totals ('0.10' + '0.20' = '00.100.20' -> NaN) and a NaN
  // difference passed as balanced.
  it('text amounts are summed as numbers: 0.10 + 0.20 against 999 is unbalanced', () => {
    const r = validateJournalEntry([
      line('0.10', 0), line('0.20', 0), { glAccountId: B, debit: 0, credit: 999 } as never,
    ]);
    expect(r.valid).toBe(false);
    expect(r.totalDebit).toBe(0.3);
    expect(r.errors.join(' ')).toMatch(/not balanced/);
  });

  it('text amounts that balance still pass', () => {
    expect(validateJournalEntry([line('0.10', 0), line('0.20', 0), { glAccountId: B, debit: 0, credit: '0.30' } as never]).valid)
      .toBe(true);
  });

  it.each([[10, 0], [0, 10], ['10', 0], [' 10.50 ', 0], ['1e3', 0], [10, undefined], [10, null]])('debit %j credit %j still passes', (debit, credit) => {
    expect(validateJournalLine(line(debit, credit)).valid).toBe(true);
  });

  // rev-nrfd round 3 LOW / brk-nrfd round 3 LOW-1: a line with no amount passed (the checks read raw values).
  it.each([[null, null], [undefined, undefined], ['0', '0'], ['0.00', '-0'], [0.004, 0], ['0.001', 0], [1e-7, 0]])(
    'debit %j credit %j has no amount once stored in cents: refused', (debit, credit) => {
      expect(validateJournalLine(line(debit, credit))).toEqual(
        { valid: false, error: 'A line must have a non-zero debit or credit amount' });
    });

  // brk-nrfd round 3 LOW-2: numeric(15,2) rounds each line half away from zero; the check now agrees with it.
  it.each([
    [[0.005, 0.005], 0.01, 0.02], [['1.005', '1.005'], 2.01, 2.02], [[1.005, 1.005], 2.01, 2.02],
  ])('debits %j against %j are stored as %j: unbalanced', (debits, credit, stored) => {
    const r = validateJournalEntry([...debits.map((d) => line(d, 0)), { glAccountId: B, debit: 0, credit } as never]);
    expect(r.totalDebit).toBe(stored);
    expect(r.valid).toBe(false);
  });

  it('a stored-balanced entry with float noise still passes', () => {
    expect(validateJournalEntry([line(0.1 + 0.2, 0), { glAccountId: B, debit: 0, credit: 0.3 } as never]).valid).toBe(true);
  });

  // rev/brk-nrfd round 4 LOW: exponent TEXT was rounded with a binary multiply; Postgres reads it exactly.
  it.each([
    ['100.5e-2', '1.00', false], ['100.5e-2', 1.01, true], ['586055e-3', 586.05, false], ['586055e-3', 586.06, true],
    ['1.005e0', 1.01, true], ['0.000001e5', 0.1, true], ['12E2', 1200, true],
  ])('debit %j against credit %j balanced as stored: %j', (debit, credit, valid) => {
    expect(validateJournalEntry([line(debit, 0), { glAccountId: B, debit: 0, credit } as never]).valid).toBe(valid);
  });

  it('exponent text below a tenth of a cent is a zero line; JS exponent numbers keep working', () => {
    expect(validateJournalLine(line('5e-4', 0)).valid).toBe(false);
    expect(validateJournalLine(line('1e-1000', 0)).valid).toBe(false);
    expect(validateJournalLine(line(1e-7, 0)).valid).toBe(false);
  });

  // rev-nrfd round 5 LOW: a zero mantissa with a huge exponent padded that many zeros (RangeError -> 500).
  // brk-nrfd round 6: a non-zero mantissa far below a cent ('1e-600000000') padded too — pins `point < -3`.
  it.each(['0e600000000', '0.000e999999999', '-0E100000000', '1e-600000000', '-1e-999999999999', `1e-${'9'.repeat(400)}`])(
    '%s is a zero amount, answered at once', (debit) => {
    const started = Date.now();
    expect(validateJournalLine(line(debit, 0)).valid).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  // Security review 2026-10-08: the amount pattern must not backtrack on a long digit run that fails at its end.
  it('a 1 MB digit run that is not an amount is refused at once', () => {
    const started = Date.now();
    expect(validateJournalLine(line(`${'1'.repeat(1_000_000)}x`, 0)).valid).toBe(false);
    expect(validateJournalLine(line(`${'1'.repeat(1_000_000)}.x`, 0)).valid).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
