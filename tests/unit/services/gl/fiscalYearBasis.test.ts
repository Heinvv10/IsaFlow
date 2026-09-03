/**
 * Fiscal year basis — "when does this company's financial year start".
 *
 * Extracted from trialBalanceBasis.ts because it is not trial-balance-specific:
 * five other sites (CIPC filing guide, PIS calculator, compliance alerts,
 * payroll period context, the pis-score route) each derive it ad hoc, and a
 * payroll caller importing "trialBalanceBasis" would read as wrong and get a
 * sixth copy written instead.
 *
 * The March default is now the CALLER's choice, never a silent one. Every
 * production company is 3 (1 March – 28/29 February), which is exactly why a
 * silent fallback is dangerous: a December year-end tenant would have been
 * closed a quarter out with nothing flagging it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

import { sql } from '@/lib/neon';
import {
  DEFAULT_FY_START_MONTH,
  fiscalYearStart,
  getFiscalYearStartMonth,
  resolveFiscalYearStartMonth,
} from '@/modules/accounting/services/gl/fiscalYearBasis';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
type SqlMock = ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('fiscalYearStart — fiscal year, never calendar year', () => {
  it('puts February 2026 in the March 2025 fiscal year', () => {
    expect(fiscalYearStart('2026-02-28', 3)).toBe('2025-03-01');
  });

  it('starts a new fiscal year on 1 March', () => {
    expect(fiscalYearStart('2026-03-01', 3)).toBe('2026-03-01');
    expect(fiscalYearStart('2026-02-28', 3)).toBe('2025-03-01');
  });

  it('keeps December in the same fiscal year as the preceding March', () => {
    expect(fiscalYearStart('2026-12-31', 3)).toBe('2026-03-01');
  });

  it('honours a January fiscal year start', () => {
    expect(fiscalYearStart('2026-06-15', 1)).toBe('2026-01-01');
    expect(fiscalYearStart('2026-01-01', 1)).toBe('2026-01-01');
  });

  it('honours a July fiscal year start', () => {
    expect(fiscalYearStart('2026-06-30', 7)).toBe('2025-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
  });

  it('honours a December fiscal year start', () => {
    expect(fiscalYearStart('2026-12-01', 12)).toBe('2026-12-01');
    expect(fiscalYearStart('2026-11-30', 12)).toBe('2025-12-01');
  });

  /**
   * Parses by string split. `new Date('2026-03-01')` is UTC midnight and
   * `.toISOString()` on a local Date reports the previous day on this UTC+2
   * host — the defect class in src/lib/pgTypes.ts.
   */
  it('parses the date by string split, never through a Date', () => {
    const spy = vi.spyOn(globalThis, 'Date' as never);
    expect(fiscalYearStart('2026-03-01', 3)).toBe('2026-03-01');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is stable across the DST-style boundary a Date round-trip would shift', () => {
    // 1 March at local midnight serialises as 28 February through toISOString().
    expect(fiscalYearStart('2026-03-01', 3)).toBe('2026-03-01');
    expect(fiscalYearStart('2026-02-28', 3)).toBe('2025-03-01');
  });

  it('refuses an unparseable date rather than guessing a year', () => {
    expect(() => fiscalYearStart('not-a-date', 3)).toThrow(/unparseable/i);
  });

  /** The silent 1–12 clamp is gone: callers now pass an already-resolved month. */
  it('refuses a month outside 1-12 rather than silently using March', () => {
    expect(() => fiscalYearStart('2026-02-28', 0)).toThrow(/1-12|out of range/i);
    expect(() => fiscalYearStart('2026-02-28', 13)).toThrow(/1-12|out of range/i);
    expect(() => fiscalYearStart('2026-02-28', Number.NaN)).toThrow(/1-12|out of range/i);
  });
});

describe('resolveFiscalYearStartMonth — the default is the caller choice', () => {
  it('accepts a configured month', () => {
    expect(resolveFiscalYearStartMonth(3, COMPANY_ID)).toBe(3);
    expect(resolveFiscalYearStartMonth('12', COMPANY_ID)).toBe(12);
  });

  it('throws on NULL when no fallback is offered, naming the company and the column', () => {
    expect(() => resolveFiscalYearStartMonth(null, COMPANY_ID)).toThrow(
      /financial_year_start/,
    );
    expect(() => resolveFiscalYearStartMonth(null, COMPANY_ID)).toThrow(
      new RegExp(COMPANY_ID),
    );
  });

  it('throws on an out-of-range value when no fallback is offered', () => {
    expect(() => resolveFiscalYearStartMonth(0, COMPANY_ID)).toThrow(/financial_year_start/);
    expect(() => resolveFiscalYearStartMonth(13, COMPANY_ID)).toThrow(/financial_year_start/);
    expect(() => resolveFiscalYearStartMonth('March', COMPANY_ID)).toThrow(/financial_year_start/);
  });

  it('uses an explicit fallback when one is given', () => {
    expect(resolveFiscalYearStartMonth(null, COMPANY_ID, { fallback: 3 })).toBe(3);
    expect(resolveFiscalYearStartMonth(99, COMPANY_ID, { fallback: 1 })).toBe(1);
  });

  it('never lets a configured value be overridden by the fallback', () => {
    expect(resolveFiscalYearStartMonth(7, COMPANY_ID, { fallback: 3 })).toBe(7);
  });

  /** A junk fallback silently becoming March is the same defect one level up. */
  it('refuses a fallback that is not itself a month', () => {
    expect(() => resolveFiscalYearStartMonth(null, COMPANY_ID, { fallback: 0 })).toThrow(/fallback/i);
    expect(() => resolveFiscalYearStartMonth(null, COMPANY_ID, { fallback: 13 })).toThrow(/fallback/i);
  });

  it('truncates a float rather than producing a fractional month', () => {
    expect(resolveFiscalYearStartMonth(3.0, COMPANY_ID)).toBe(3);
  });
});

describe('getFiscalYearStartMonth', () => {
  it('returns the configured month', async () => {
    (sql as SqlMock).mockResolvedValueOnce([{ financial_year_start: 3 }]);
    expect(await getFiscalYearStartMonth(COMPANY_ID)).toBe(3);
  });

  it('reads the RAW column — a COALESCE in the query would hide the misconfiguration', async () => {
    const mockSql = sql as SqlMock;
    mockSql.mockResolvedValueOnce([{ financial_year_start: 3 }]);
    await getFiscalYearStartMonth(COMPANY_ID);
    const text = ((mockSql.mock.calls[0] as unknown[])[0] as string[]).join(' ? ');
    expect(text).toContain('financial_year_start');
    expect(text).not.toContain('COALESCE');
  });

  it('scopes the lookup to the company', async () => {
    const mockSql = sql as SqlMock;
    mockSql.mockResolvedValueOnce([{ financial_year_start: 3 }]);
    await getFiscalYearStartMonth(COMPANY_ID);
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(COMPANY_ID);
  });

  it('throws when the company has no usable value and no fallback was offered', async () => {
    (sql as SqlMock).mockResolvedValueOnce([{ financial_year_start: null }]);
    await expect(getFiscalYearStartMonth(COMPANY_ID)).rejects.toThrow(/financial_year_start/);
  });

  it('applies an explicit fallback', async () => {
    (sql as SqlMock).mockResolvedValueOnce([{ financial_year_start: null }]);
    expect(await getFiscalYearStartMonth(COMPANY_ID, { fallback: DEFAULT_FY_START_MONTH })).toBe(3);
  });

  /**
   * A company that does not exist is a caller bug or a tenant-scoping failure,
   * not a misconfigured tenant. A fallback must not paper over it.
   */
  it('throws on an unknown company even when a fallback is offered', async () => {
    (sql as SqlMock).mockResolvedValueOnce([]);
    await expect(
      getFiscalYearStartMonth(COMPANY_ID, { fallback: 3 }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('DEFAULT_FY_START_MONTH', () => {
  it('is March, matching every production company and the column default', () => {
    expect(DEFAULT_FY_START_MONTH).toBe(3);
  });
});
