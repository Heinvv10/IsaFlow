/** The Reconcile link's query is untrusted: each field is validated alone and a bad one is dropped. */
import { describe, expect, it } from 'vitest';
import { parseReconcilePrefill } from '@/components/accounting/bank-transactions/reconcilePrefill';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('parseReconcilePrefill', () => {
  it('accepts a UUID, a real date and a two-decimal amount', () => {
    expect(parseReconcilePrefill({ bankAccountId: ID, statementDate: '2026-10-31', statementBalance: '2500.00' }))
      .toEqual({ bankAccountId: ID, statementDate: '2026-10-31', statementBalance: 2500 });
  });
  it('accepts a negative balance (an overdrawn statement)', () => {
    expect(parseReconcilePrefill({ statementBalance: '-12.5' })).toEqual({ statementBalance: -12.5 });
  });
  it('drops each bad field on its own and keeps the good ones', () => {
    expect(parseReconcilePrefill({ bankAccountId: 'not-a-uuid', statementDate: '2026-02-30', statementBalance: '1.234' })).toEqual({});
    expect(parseReconcilePrefill({ bankAccountId: ID, statementDate: '31/10/2026', statementBalance: '1e5' })).toEqual({ bankAccountId: ID });
    expect(parseReconcilePrefill({ statementBalance: '12abc' })).toEqual({});
  });
  it('knows leap years: 29 Feb exists in 2028 and 2000, not in 2026 or 2100', () => {
    const d = (statementDate: string) => parseReconcilePrefill({ statementDate }).statementDate;
    expect([d('2028-02-29'), d('2000-02-29'), d('2026-02-29'), d('2100-02-29')]).toEqual(['2028-02-29', '2000-02-29', undefined, undefined]);
  });
  it('keeps cents exact up to R999 999 999 999.99 and refuses what a double cannot hold', () => {
    const bal = (v: string) => parseReconcilePrefill({ statementBalance: v }).statementBalance;
    expect(bal('999999999999.99')).toBe(999999999999.99);
    expect(String(bal('999999999999.99'))).toBe('999999999999.99');
    expect(bal('999999999999999.99')).toBeUndefined(); // 17 significant digits: a double rounds it
    expect(bal('1000000000000')).toBeUndefined();
  });
  it('ignores repeated (array) parameters and missing ones', () => {
    expect(parseReconcilePrefill({ bankAccountId: [ID, ID] })).toEqual({});
    expect(parseReconcilePrefill({})).toEqual({});
  });
});
