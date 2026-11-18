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
import { FinancialYearStartLoadedMissingError } from '@/modules/accounting/services/gl/financialYearStartGuard';

const CO = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { db.calls = 0; });

describe('assertFinancialYearStartChange: what counts as a month', () => {
  it.each([[true], [false], [[6]], ['6'], [''], [0], [13], [6.5], [-1], [Number.NaN], [{}]])('refuses %j with a 400 error before any query', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw, 3)).rejects.toBeInstanceOf(InvalidFinancialYearStartError);
    expect(db.calls).toBe(0);
  });

  it.each([[undefined], [null]])('treats %j as no change, without a query (and judges no loaded month)', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw, undefined)).resolves.toBe(false);
    expect(db.calls).toBe(0);
  });

  it.each([[1], [6], [12]])('accepts %j and goes on to read the company', async (raw) => {
    await expect(assertFinancialYearStartChange(CO, raw, raw)).resolves.toBe(false);
    expect(db.calls).toBeGreaterThan(0);
  });
});

describe('assertFinancialYearStartChange: the month the caller loaded (PR #1551)', () => {
  it.each([[undefined], [true], ['3'], [13], [-1], [2.5], [[3]]])('refuses a sent month with loaded %j: 400, before any query', async (loaded) => {
    await expect(assertFinancialYearStartChange(CO, 3, loaded)).rejects.toBeInstanceOf(FinancialYearStartLoadedMissingError);
    expect(db.calls).toBe(0);
  });

  it.each([[null], [0], [1], [12]])('accepts loaded %j (NULL and 0 read as March, as the row) and goes on to read the company', async (loaded) => {
    await expect(assertFinancialYearStartChange(CO, 3, loaded)).resolves.toBe(false);
    expect(db.calls).toBeGreaterThan(0);
  });
});
