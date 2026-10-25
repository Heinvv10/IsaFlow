/**
 * `markCreditCeilingSkips` — the back-fill's half of the AP on-account credit ceiling (2026-10-25). Decided in the
 * population so a dry run and a live run skip the same sources; the live plan refuses the same application.
 */
import { describe, it, expect } from 'vitest';
import {
  markCreditCeilingSkips, SKIP_CREDIT_CEILING, SKIP_NO_FISCAL_PERIOD,
} from '@/modules/accounting/services/shared/autoApplyBackfillSkips';
import type { BackfillSource } from '@/modules/accounting/services/shared/autoApplyBackfillPlan';

/** Each supplier's all-dates credit, as `getSupplierOnAccountCredits` hands it to the population. */
const credit = (entries: Record<string, number>) => new Map(Object.entries(entries));
const source = (paymentId: string, entityId: string, remainder: number, over: Partial<BackfillSource> = {}) =>
  ({ kind: 'payment', paymentId, paymentNumber: paymentId, entityId, entityName: '', paymentDate: '2026-05-15',
    remainder, journalEntryId: 'je', skippedReason: null, ...over }) as BackfillSource;
const reasons = (out: BackfillSource[]) => out.map((s) => [s.paymentId, s.skippedReason ?? null]);

describe('markCreditCeilingSkips', () => {
  it('passes every source a supplier\'s credit covers', () => {
    const out = markCreditCeilingSkips('ap', credit({ s: 800 }), [source('a', 'S', 500), source('b', 'S', 300)]);
    expect(reasons(out)).toEqual([['a', null], ['b', null]]);
  });

  it('skips the sources a refund has already taken the credit for, oldest first kept', () => {
    const out = markCreditCeilingSkips('ap', credit({ s: 500 }),
      [source('a', 'S', 500), source('b', 'S', 300)]);
    expect(reasons(out)).toEqual([['a', null], ['b', SKIP_CREDIT_CEILING]]);
  });

  it('keeps suppliers apart, and matches the entity id case-insensitively', () => {
    const out = markCreditCeilingSkips('ap', credit({ s: 0, t: 100 }),
      [source('a', 'S', 500), source('t', 'T', 100)]);
    expect(reasons(out)).toEqual([['a', SKIP_CREDIT_CEILING], ['t', null]]);
  });

  it('a source already skipped consumes no credit and keeps its own reason', () => {
    const out = markCreditCeilingSkips('ap', credit({ s: 500 }),
      [source('a', 'S', 500, { skippedReason: SKIP_NO_FISCAL_PERIOD }), source('b', 'S', 300)]);
    expect(reasons(out)).toEqual([['a', SKIP_NO_FISCAL_PERIOD], ['b', null]]);
  });

  it('compares in whole cents: a source exactly at the credit passes', () => {
    const out = markCreditCeilingSkips('ap', credit({ s: 100.1 + 0.2 - 0.3 }), [source('a', 'S', 100)]);
    expect(reasons(out)).toEqual([['a', null]]);
  });

  it('leaves AR and credit notes alone', () => {
    expect(reasons(markCreditCeilingSkips('ar', credit({ c: -500 }), [source('r', 'C', 100)]))).toEqual([['r', null]]);
    const note = source('n', 'S', 100, { kind: 'credit_note' } as Partial<BackfillSource>);
    expect(reasons(markCreditCeilingSkips('ap', credit({ s: -500 }), [note]))).toEqual([['n', null]]);
  });
});
