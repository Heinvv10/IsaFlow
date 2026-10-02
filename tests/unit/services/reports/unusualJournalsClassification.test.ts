/**
 * WHICH JOURNALS PAGE 11 CALLS UNUSUAL, RUN OVER ROWS.
 *
 * `unusualJournalsScope.test.ts` pins the query's shape and hands the service
 * no rows, so the loop that decides what a board is shown — the round-number
 * floor, the thousand rule, the backdating threshold, which reason wins — ran
 * in no test at all. Every case here feeds rows through `getUnusualJournals`
 * and reads the flags it returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const WINDOW = { start: '2026-03-01', end: '2026-03-31' };

interface Row {
  id: string;
  entry_number: string | null;
  entry_date: string | Date;
  description: string | null;
  created_at: string | Date;
  amount: number | string;
}

/** A journal recorded on the day it is dated, for an amount that is not
 *  round — flagged by neither rule until a test changes one field. */
function journal(over: Partial<Row> = {}): Row {
  return {
    id: 'je-1',
    entry_number: 'JE-0001',
    entry_date: '2026-03-10',
    description: 'Accrual',
    created_at: new Date('2026-03-10T08:00:00.000Z'),
    amount: 12_345.67,
    ...over,
  };
}

async function flagsFor(...rows: Row[]) {
  // The window's rows, and — where one is late — the same rows again as the
  // census of the days they were recorded on: one late journal on its day,
  // under `BULK_LOAD_MIN`, so the backdating rule here is the per-journal one.
  // `unusualJournalsBulkLoad.test.ts` holds the bulk-load case.
  sqlSpy.mockResolvedValue(rows);
  return (await getUnusualJournals(COMPANY, WINDOW)).flags;
}

async function reasonOf(over: Partial<Row>): Promise<string | null> {
  const flags = await flagsFor(journal(over));
  return flags[0]?.reason ?? null;
}

beforeEach(() => {
  sqlSpy.mockReset();
});

describe('a round number', () => {
  it('is flagged from 10 000 and not a rand below it', async () => {
    expect(await reasonOf({ amount: 10_000 })).toBe('round_number');
    // 9 000 is as round as 10 000 and is below the floor.
    expect(await reasonOf({ amount: 9_000 })).toBeNull();
    expect(await reasonOf({ amount: 1_000 })).toBeNull();
  });

  it('is a whole number of thousands', async () => {
    expect(await reasonOf({ amount: 11_000 })).toBe('round_number');
    expect(await reasonOf({ amount: 250_000 })).toBe('round_number');
    // Round to the hundred, the fifty and the cent are not round enough.
    expect(await reasonOf({ amount: 10_500 })).toBeNull();
    expect(await reasonOf({ amount: 10_050 })).toBeNull();
    expect(await reasonOf({ amount: 10_000.01 })).toBeNull();
  });

  it('is read from the NUMERIC string the driver returns', async () => {
    expect(await reasonOf({ amount: '207000.00' })).toBe('round_number');
    const [flag] = await flagsFor(journal({ amount: '207000.00' }));
    expect(flag!.amount).toBe(207_000);
  });
});

describe('a backdated entry', () => {
  it('is one recorded more than five days after the date it carries', async () => {
    // Dated 1 March. Recorded at the last instant of the 6th it is five whole
    // days late, which is month-end lag; from the first instant of the 7th it
    // is six.
    expect(await reasonOf({
      entry_date: '2026-03-01', created_at: new Date('2026-03-06T23:59:59.999Z'),
    })).toBeNull();
    expect(await reasonOf({
      entry_date: '2026-03-01', created_at: new Date('2026-03-07T00:00:00.000Z'),
    })).toBe('backdated');
  });

  it('is recognised whether the timestamp arrives as a Date or as text', async () => {
    expect(await reasonOf({
      entry_date: '2026-03-01', created_at: '2026-03-20T10:00:00.000Z',
    })).toBe('backdated');
  });

  it('is not an entry recorded before its own date', async () => {
    // A journal captured ahead of the date it is posted to is early, not late.
    expect(await reasonOf({
      entry_date: '2026-03-20', created_at: new Date('2026-03-01T10:00:00.000Z'),
    })).toBeNull();
  });
});

describe('an entry that is both', () => {
  it('is reported as a round number, the more specific claim', async () => {
    expect(await reasonOf({
      amount: 50_000, entry_date: '2026-03-01', created_at: new Date('2026-03-25T10:00:00.000Z'),
    })).toBe('round_number');
  });
});

describe('what comes back', () => {
  it('is only the journals a rule flagged, in the order the query returned them', async () => {
    const flags = await flagsFor(
      journal({ id: 'a', amount: 40_000 }),
      journal({ id: 'b', amount: 12_345.67 }),
      journal({ id: 'c', amount: 500, entry_date: '2026-03-01', created_at: new Date('2026-03-30T10:00:00.000Z') }),
    );
    expect(flags.map((f) => [f.entryId, f.reason])).toEqual([
      ['a', 'round_number'],
      ['c', 'backdated'],
    ]);
  });

  it('carries the entry as the page prints it, absent fields as null', async () => {
    const [flag] = await flagsFor(journal({
      id: 'je-9', entry_number: null, description: null, amount: 20_000, entry_date: '2026-03-15',
    }));
    expect(flag).toEqual({
      entryId: 'je-9',
      entryNumber: null,
      entryDate: '2026-03-15',
      description: null,
      amount: 20_000,
      reason: 'round_number',
    });
  });
});

describe('the query the rows come from', () => {
  /** The literal SQL between the interpolations, comments removed, and the
   *  values bound into it. */
  async function emitted(): Promise<{ strings: string[]; values: unknown[] }> {
    await flagsFor();
    const [raw, ...values] = sqlSpy.mock.calls[0]! as [readonly string[], ...unknown[]];
    return { strings: raw.map((s) => s.replace(/--[^\n]*/g, '')), values };
  }

  /** The value bound immediately after the fragment ending in `before`. */
  function boundAfter(q: { strings: string[]; values: unknown[] }, before: RegExp): unknown {
    const at = q.strings.findIndex((s) => before.test(s));
    expect(at, `no SQL fragment ends with ${String(before)}`).toBeGreaterThanOrEqual(0);
    return q.values[at];
  }

  it('counts posted journals only', async () => {
    // A draft or a reversed entry is not something the ledger asserts, and a
    // board is not asked to rule on it.
    const q = await emitted();
    expect(q.strings.join('$')).toMatch(/AND je\.status = 'posted'/);
  });

  it('binds the company it was asked about to the entries and to the lines', async () => {
    const q = await emitted();
    expect(boundAfter(q, /WHERE je\.company_id = $/)).toBe(COMPANY);
    expect(boundAfter(q, /AND jl\.company_id = $/)).toBe(COMPANY);
  });

  it('binds the window it was asked about', async () => {
    const q = await emitted();
    expect(boundAfter(q, /je\.entry_date BETWEEN $/)).toBe(WINDOW.start);
    expect(boundAfter(q, /::DATE AND $/)).toBe(WINDOW.end);
  });
});
