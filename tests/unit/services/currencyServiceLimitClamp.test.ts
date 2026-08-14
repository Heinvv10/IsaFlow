/**
 * Pentest finding #11 (LOW, unbounded LIMIT): getExchangeRates() must clamp
 * an absurd/NaN/negative `limit` before it reaches the SQL LIMIT clause.
 * Regression pin for currencyService — the API layer (exchange-rates.ts)
 * now clamps too via clampLimit(), but the service must not trust callers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getExchangeRates } from '@/modules/accounting/services/core/currencyService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function limitArgFromLastCall(): unknown {
  const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
  const call = mockSql.mock.calls.at(-1) as unknown[];
  // sql`... LIMIT ${limit}` → tagged template call: (strings, ...values)
  const values = call.slice(1) as unknown[];
  return values.at(-1);
}

describe('currencyService.getExchangeRates limit clamp', () => {
  beforeEach(() => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('defaults to 100 when no limit is provided', async () => {
    await getExchangeRates(COMPANY_ID);
    expect(limitArgFromLastCall()).toBe(100);
  });

  it('clamps an absurdly large limit to the 1000 cap', async () => {
    await getExchangeRates(COMPANY_ID, { limit: 999_999_999 });
    expect(limitArgFromLastCall()).toBe(1000);
  });

  it('clamps a negative limit to the default', async () => {
    await getExchangeRates(COMPANY_ID, { limit: -1 });
    expect(limitArgFromLastCall()).toBe(100);
  });

  it('clamps a NaN limit (e.g. from Number("abc")) to the default', async () => {
    await getExchangeRates(COMPANY_ID, { limit: Number('abc') });
    expect(limitArgFromLastCall()).toBe(100);
  });

  it('passes a valid within-range limit through unchanged', async () => {
    await getExchangeRates(COMPANY_ID, { limit: 25 });
    expect(limitArgFromLastCall()).toBe(25);
  });
});
