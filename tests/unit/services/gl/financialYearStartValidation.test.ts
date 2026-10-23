/**
 * assertFinancialYearStartChange accepts only a real integer month 1..12, or an
 * absent value (undefined / null: no change). `Number(requested)` let `true`
 * through as January and `[6]` as June. The settings page sends a number (the
 * select's Number(e.target.value), mapApiCompany's numeric column), so a numeric
 * STRING is not something the app sends and is refused too. (updateCompany maps
 * '' to null before calling, so a blank never reaches this as a 400.)
 *
 * Validation runs before any query: the sql mock records whether one ran.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => { db.calls += 1; return []; }), // no such company: the check ends there
  withTransaction: vi.fn(), withSavepoint: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  assertFinancialYearStartChange, InvalidFinancialYearStartError,
} from '@/modules/accounting/services/gl/fiscalYearStartChange';

const CO = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { db.calls = 0; });

describe('assertFinancialYearStartChange: what counts as a month', () => {
  it.each([[true], [false], [[6]], ['6'], [''], [0], [13], [6.5], [-1], [Number.NaN], [{}]])('refuses %j with a 400 error before any query', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw)).rejects.toBeInstanceOf(InvalidFinancialYearStartError);
    expect(db.calls).toBe(0);
  });

  it.each([[undefined], [null]])('treats %j as no change, without a query', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw)).resolves.toBe(false);
    expect(db.calls).toBe(0);
  });

  it.each([[1], [6], [12]])('accepts %j and goes on to read the company', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw)).resolves.toBe(false);
    expect(db.calls).toBeGreaterThan(0);
  });
});
