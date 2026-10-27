/**
 * seedVersion's CALL ORDER (PR-D review M1), with mocks: holdYearRegistry comes first, before the
 * version row locks (lockSeedVersions) and before `plan()` reads the target year (getFiscalYear).
 * This pins the order of the calls only; no lock is taken here. The real lock proof is against
 * PostgreSQL: budgets-year-end-seed-race.int (a seed racing a shortening change of year end writes
 * only months the new year holds) and budgets-year-end-rehome.int (seeds racing the change and a
 * start-month change wait for them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const STOP = vi.hoisted(() => new Error('stop after the year read'));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionScope', () => ({
  holdYearRegistry: vi.fn(async () => { calls.push('holdYearRegistry'); }),
  auditBudgetWrite: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/seedSeries', () => ({
  lockSeedVersions: vi.fn(async () => { calls.push('lockSeedVersions'); return null; }),
  loadSeedAccounts: vi.fn(), pySeries: vi.fn(), versionSeries: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({
  getFiscalYear: vi.fn(async () => { calls.push('getFiscalYear'); throw STOP; }),
}));

import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';

beforeEach(() => { calls.length = 0; });

describe('seedVersion lock order', () => {
  it.each([
    ['blank, make primary', { type: 'blank' as const }, true],
    ['prior-year actuals, not primary (takes no version row lock)', { type: 'py_actuals' as const, upliftPct: 10, grain: 'company' as const }, false],
  ])('%s: holds the year registry before any version lock and before reading the year', async (_, source, makePrimary) => {
    await expect(seedVersion('c0000000-0000-4000-8000-000000000001', { userId: 'u1', role: 'owner' },
      { fiscalYear: 2027, name: 'Seed', kind: 'scenario', makePrimary, roundingUnit: 1, source })).rejects.toBe(STOP);
    expect(calls[0]).toBe('holdYearRegistry');
    expect(calls).toEqual(['holdYearRegistry', 'lockSeedVersions', 'getFiscalYear']);
  });
});
