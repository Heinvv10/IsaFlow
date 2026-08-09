/**
 * The acceptance gate needs its own gate.
 *
 * scripts/mcp-recon-benchmark.ts decides whether the "agent does the work"
 * slice is trustworthy, and its header records THREE bugs that each made it
 * structurally unable to fail: a numerator matching `status = 'reversed'`
 * (0 rows on prod), a denominator read through a LIMIT 50 while the numerator
 * was unbounded, and reversal contras inflating the denominator. Every one of
 * those was a property of the query TEXT, so these tests read the query the
 * script actually issues rather than a re-typed copy — a test over a copy
 * would have passed against all three.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

import { sql } from '@/lib/neon';
import {
  CORRECTION_THRESHOLD_PCT,
  decide,
  fetchCounts,
} from '../../../scripts/mcp-recon-benchmark';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';

/** The SQL the script really sends, placeholders collapsed to `?`. */
async function capturedSql(): Promise<string> {
  mockSql.mockResolvedValue([{ total: 10, reversed: 0 }]);
  await fetchCounts(COMPANY_ID, '2026-01-01', '2026-01-31');
  const strings = mockSql.mock.calls[0]![0] as TemplateStringsArray;
  return strings.join('?');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('benchmark query', () => {
  it('counts a correction as reversed_at IS NOT NULL, never status = reversed', async () => {
    const text = await capturedSql();

    expect(text).toMatch(/reversed_at\s+IS\s+NOT\s+NULL/i);
    // Reversal keeps the original at status 'posted' (journalEntryPostingService),
    // so this predicate matched 0 rows on prod against 38 carrying reversed_at:
    // the numerator was always 0 and the harness always printed PASS.
    expect(text).not.toMatch(/status\s*=\s*'reversed'/i);
  });

  it('takes numerator and denominator from ONE uncapped query over ONE population', async () => {
    const text = await capturedSql();

    expect(mockSql).toHaveBeenCalledTimes(1);          // not two populations
    expect(text).toMatch(/COUNT\(\*\)\s*(::int)?\s+AS\s+total/i);
    expect(text).toMatch(/COUNT\(\*\)\s+FILTER\s*\(/i); // numerator is a FILTER over the same rows
    expect(text.match(/\bFROM\b/gi)).toHaveLength(1);   // one population, not two queries stitched
    // Exactly one row-selecting WHERE: every other WHERE belongs to a FILTER,
    // i.e. it narrows the numerator INSIDE the denominator's row set rather
    // than selecting a different set of rows.
    const filters = (text.match(/\bFILTER\s*\(\s*WHERE\b/gi) ?? []).length;
    const wheres = (text.match(/\bWHERE\b/gi) ?? []).length;
    expect(wheres - filters).toBe(1);
    expect(filters).toBe(1);
    // A LIMIT is what made the denominator (read via listAgentPostings) top out
    // at 50 while the numerator's COUNT(*) stayed unbounded.
    expect(text).not.toMatch(/\bLIMIT\b/i);
  });

  it('scopes to the company and excludes reversal contras from the denominator', async () => {
    const text = await capturedSql();

    expect(text).toMatch(/je\.company_id\s*=\s*\?/i);   // multi-tenant: never unscoped
    expect(text).toMatch(/posting_agent\s+LIKE\s+'mcp:%'/i);
    // Contras carry mcp:reverse_bank_allocation:v1 themselves; counting them
    // would add a denominator row per correction without adding a numerator
    // one, diluting the very rate meant to catch mistakes.
    expect(text).toMatch(/reversal_of_id\s+IS\s+NULL/i);
  });

  it('defaults to zero rather than NaN when the query returns no row', async () => {
    mockSql.mockResolvedValue([]);

    await expect(fetchCounts(COMPANY_ID, '2026-01-01', '2026-01-31')).resolves.toEqual({
      total: 0,
      reversed: 0,
    });
  });
});

describe('decide', () => {
  it('reports NOT MEASURED (exit 3) on zero postings instead of a silent PASS', () => {
    // total === 0 gives rate === 0, which a naive `rate < 5` reads as a clean
    // month — indistinguishable from "the agent never ran" to anything that
    // only checks the exit code.
    expect(decide({ total: 0, reversed: 0 })).toEqual({
      measured: false, rate: null, verdict: 'NOT MEASURED', exitCode: 3,
    });
  });

  it('fails (exit 1) when the correction rate is above the threshold', () => {
    const d = decide({ total: 100, reversed: 12 }); // 12%

    expect(d.verdict).toBe('FAIL');
    expect(d.exitCode).toBe(1);
    expect(d.rate).toBeCloseTo(12, 6);
  });

  it('passes (exit 0) when the correction rate is below the threshold', () => {
    const d = decide({ total: 100, reversed: 2 }); // 2%

    expect(d.verdict).toBe('PASS');
    expect(d.exitCode).toBe(0);
    expect(d.rate).toBeCloseTo(2, 6);
  });

  it('treats exactly the threshold as a failure — 5% is not "under 5%"', () => {
    expect(decide({ total: 100, reversed: CORRECTION_THRESHOLD_PCT }).exitCode).toBe(1);
    expect(decide({ total: 100, reversed: CORRECTION_THRESHOLD_PCT - 1 }).exitCode).toBe(0);
  });

  it('gives each outcome a distinct exit code so CI can tell them apart', () => {
    const codes = [
      decide({ total: 0, reversed: 0 }).exitCode,
      decide({ total: 10, reversed: 0 }).exitCode,
      decide({ total: 10, reversed: 10 }).exitCode,
    ];

    expect(new Set(codes).size).toBe(3);
  });
});
