/**
 * K-030 — the cached-run key must cover the loan's financial terms.
 *
 * buildInputsHash originally hashed only the loan id, its events and its rate
 * points, so a principal, rate, term or residual edit kept the pre-edit
 * amortisation cached. This unit test guards the key without a database, so the
 * regression is caught by `bun run ci` on a machine with no DATABASE_URL, where
 * the integration suite is skipped. loanScheduleInputs.ts is pure, so no mocks.
 */

import { describe, it, expect } from 'vitest';

import { buildInputsHash } from '@/modules/accounting/services/loans/loanScheduleInputs';

const loan = {
  id: '11111111-1111-4111-8111-111111111111',
  principal: '100000',
  start_date: '2026-01-31',
  term_months: 60,
  rate_mode: 'FIXED',
  margin: '0',
  fixed_rate: '12',
  residual: '0',
  recurring_skip_months: [],
  day_count: 'ACTUAL_365',
  reprice_mode: 'RESOLVE_ON_RATE_CHANGE',
  skip_mode: 'EXTEND_TERM',
  lump_mode: 'REDUCE_INSTALLMENT',
};

describe('buildInputsHash', () => {
  it('changes when the principal is edited', () => {
    const before = buildInputsHash(loan, [], []);
    const after = buildInputsHash({ ...loan, principal: '250000' }, [], []);
    expect(after).not.toBe(before);
  });

  it.each(['fixed_rate', 'term_months', 'residual', 'start_date', 'day_count'] as const)(
    'changes when %s is edited',
    (field) => {
      const edited = { ...loan, [field]: field === 'start_date' ? '2026-02-28'
        : field === 'day_count' ? 'ACTUAL_360' : '84' };
      expect(buildInputsHash(edited, [], [])).not.toBe(buildInputsHash(loan, [], []));
    },
  );

  it('is stable across repeated calls on identical inputs', () => {
    expect(buildInputsHash(loan, [], [])).toBe(buildInputsHash({ ...loan }, [], []));
  });

  it('ignores columns the engine never reads', () => {
    const touched = { ...loan, updated_at: '2026-09-09T00:00:00Z', reference: 'RENAMED' };
    expect(buildInputsHash(touched, [], [])).toBe(buildInputsHash(loan, [], []));
  });

  it('normalises rows that arrive out of date order', () => {
    // The date sort makes the key independent of the order the array arrives in.
    // fetchEvents/fetchRatePoints also order by (date, id), so same-date ties are
    // already fixed before they reach here.
    const a = { kind: 'LUMP', event_date: '2026-03-31', amount: '500' };
    const b = { kind: 'LUMP', event_date: '2026-03-31', amount: '900' };
    const c = { kind: 'LUMP', event_date: '2026-01-31', amount: '100' };
    expect(buildInputsHash(loan, [c, a, b], [])).toBe(buildInputsHash(loan, [c, a, b], []));
    expect(buildInputsHash(loan, [a, b, c], [])).toBe(buildInputsHash(loan, [c, a, b], []));
  });

  it('changes when an event amount changes', () => {
    const a = { kind: 'LUMP', event_date: '2026-03-31', amount: '500' };
    expect(buildInputsHash(loan, [a], [])).not.toBe(
      buildInputsHash(loan, [{ ...a, amount: '900' }], []),
    );
  });
});
