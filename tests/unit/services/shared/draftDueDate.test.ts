/**
 * The draft-edit re-date rule (payment-terms programme, Part A): an edit that moves the invoice date (or, on a customer
 * invoice, the customer) re-dates a due date that came from terms, unless the edit names a different date. Server-side,
 * so API and MCP callers get it as the pages do.
 */
import { describe, it, expect, vi } from 'vitest';
import { redatedDueDate } from '@/modules/accounting/services/shared/draftDueDate';

const TERMS = { dueDate: '2026-11-30', source: 'terms' as const };
const run = (over: Partial<Parameters<typeof redatedDueDate>[0]> = {}) => {
  const termsDate = vi.fn(async () => TERMS);
  const base = { storedSource: 'terms', moved: true, storedDueDate: '2026-10-31', givenDueDate: undefined, termsDate };
  return redatedDueDate({ ...base, ...over, termsDate: over.termsDate ?? termsDate }).then((r) => ({ r, termsDate }));
};

describe('redatedDueDate', () => {
  it.each([
    ['no due date in the edit', undefined],
    ['null due date', null],
    ['the stored date re-sent (the pages do)', '2026-10-31'],
    ['the date the terms give', '2026-11-30'],
  ])('a terms-sourced date moves with the invoice date: %s', async (_n, given) => {
    const { r } = await run({ givenDueDate: given });
    expect(r).toEqual({ dueDate: '2026-11-30', source: 'terms' });
  });

  it('a different date named in the edit is the caller\'s: not re-dated', async () => {
    const { r } = await run({ givenDueDate: '2026-12-15' });
    expect(r).toBeNull();
  });

  it.each(['manual', 'document', 'legacy', 'nonsense', null, undefined])('a %s due date is never moved', async (source) => {
    const { r, termsDate } = await run({ storedSource: source });
    expect(r).toBeNull();
    expect(termsDate).not.toHaveBeenCalled(); // and the terms are not even read
  });

  it('an edit that moves neither the invoice date nor the customer leaves it, and reads nothing', async () => {
    const { r, termsDate } = await run({ moved: false });
    expect(r).toBeNull();
    expect(termsDate).not.toHaveBeenCalled();
  });

  it('no stored date yet: the terms give one', async () => {
    const { r } = await run({ storedDueDate: null });
    expect(r).toEqual({ dueDate: '2026-11-30', source: 'terms' });
  });

  it('terms that give no date leave it alone', async () => {
    const { r } = await run({ termsDate: async () => ({ dueDate: null, source: 'terms' as const }) });
    expect(r).toBeNull();
  });

  it('keeps the source the terms resolver names (a bill\'s own chosen terms are manual)', async () => {
    const { r } = await run({ termsDate: async () => ({ dueDate: '2026-11-15', source: 'manual' as const }) });
    expect(r).toEqual({ dueDate: '2026-11-15', source: 'manual' });
  });
});
