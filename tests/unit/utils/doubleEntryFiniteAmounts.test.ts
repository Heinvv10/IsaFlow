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
  ])('debit %j credit %j is refused', (debit, credit) => {
    expect(validateJournalLine(line(debit, credit))).toEqual({ valid: false, error: 'Debit and credit must be numbers' });
  });

  it('a NaN pair (the attack: balanced only because NaN = NaN in SQL) fails the entry', () => {
    const r = validateJournalEntry([line(NaN, NaN), { glAccountId: B, debit: NaN, credit: NaN } as never]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/must be numbers/);
  });

  it.each([[10, 0], [0, 10], ['10', 0], [10, undefined], [10, null]])('debit %j credit %j still passes', (debit, credit) => {
    expect(validateJournalLine(line(debit, credit)).valid).toBe(true);
  });
});
