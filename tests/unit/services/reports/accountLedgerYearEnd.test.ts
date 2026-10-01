import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import {
  buildPageRows,
  loadYearEndCloses,
  planPage,
  type YearEndClose,
} from '@/modules/accounting/services/reports/accountLedgerYearEnd';

const close = (position: number, balanceBefore: number, boundary = '2025-03-01'): YearEndClose => ({
  boundary, balanceBefore, position,
});

describe('planPage', () => {
  it('passes the window straight through when there are no closes', () => {
    expect(planPage([], 200, 100)).toEqual({ lineOffset: 200, lineLimit: 100, closesBefore: [] });
  });

  // Combined sequence: L0 L1 C(2) L2 L3 -> a close at position 2.
  const closes = [close(2, 50)];

  it('a page ending just before the close needs only lines', () => {
    expect(planPage(closes, 0, 2)).toEqual({ lineOffset: 0, lineLimit: 2, closesBefore: [] });
  });

  it('a page STARTING exactly on the close owns it: one fewer line, no close before', () => {
    expect(planPage(closes, 2, 2)).toEqual({ lineOffset: 2, lineLimit: 1, closesBefore: [] });
  });

  it('a page starting just after the close skips one line-offset for it', () => {
    const plan = planPage(closes, 3, 2);
    expect(plan.lineOffset).toBe(2);
    expect(plan.lineLimit).toBe(2);
    expect(plan.closesBefore).toEqual(closes);
  });

  it('the last page (past every close) offsets by every close', () => {
    const two = [close(2, 50), close(5, 20, '2026-03-01')];
    expect(planPage(two, 6, 10)).toEqual({ lineOffset: 4, lineLimit: 10, closesBefore: two });
  });

  it('a page holding two closes takes two fewer lines', () => {
    const two = [close(1, 50), close(2, 20, '2026-03-01')];
    expect(planPage(two, 0, 4)).toEqual({ lineOffset: 0, lineLimit: 2, closesBefore: [] });
  });
});

describe('buildPageRows', () => {
  const line = (id: string, date: string, debit: number, credit: number) => ({
    journal_entry_id: id, entry_date: date, entry_number: `JE-${id}`, description: `d${id}`,
    reference: '', source: 'manual', debit, credit,
  });

  it('interleaves the close at its position and restarts the balance from zero', () => {
    // credit-normal: opening 0; +40, +10, close(50), +5
    const rows = buildPageRows(
      [line('a', '2025-01-10', 0, 40), line('b', '2025-02-10', 0, 10), line('c', '2025-03-05', 0, 5)],
      [close(2, 50)], { offset: 0, limit: 4 }, 0, 'credit',
    );
    expect(rows.map(r => [r.entryDate, r.runningBalance, !!r.derived])).toEqual([
      ['2025-01-10', 40, false], ['2025-02-10', 50, false], ['2025-02-28', 0, true], ['2025-03-05', 5, false],
    ]);
    expect(rows[2]).toMatchObject({ debit: 50, credit: 0, source: 'year_end_close', journalEntryId: '' });
  });

  it('a page that starts on the close emits it first, from the carried-in balance', () => {
    const rows = buildPageRows([line('c', '2025-03-05', 0, 5)], [close(2, 50)], { offset: 2, limit: 2 }, 50, 'credit');
    expect(rows.map(r => [r.derived === true, r.runningBalance])).toEqual([[true, 0], [false, 5]]);
  });

  it('the last page stops when lines run out, without padding to the limit', () => {
    const rows = buildPageRows([line('z', '2025-04-01', 7, 0)], [], { offset: 200, limit: 200 }, 100, 'debit');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runningBalance).toBe(107);
  });

  it('an account with no movement and no closes yields no rows', () => {
    expect(buildPageRows([], [], { offset: 0, limit: 200 }, 0, 'credit')).toEqual([]);
  });

  it('an empty year (close only, no lines in the window) is a single derived row', () => {
    const rows = buildPageRows([], [close(0, 25)], { offset: 0, limit: 1 }, 25, 'credit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ derived: true, debit: 25, credit: 0, runningBalance: 0 });
  });

  it('closes a debit-normal balance with a credit', () => {
    const rows = buildPageRows([], [close(0, 30)], { offset: 0, limit: 1 }, 30, 'debit');
    expect(rows[0]).toMatchObject({ debit: 0, credit: 30, runningBalance: 0 });
  });
});

describe('loadYearEndCloses — one grouped query, not one per fiscal year', () => {
  const scope = {
    companyId: 'c', accountId: 'a', cc: null, bu: null, postedOnly: true,
    fromDate: '2025-01-01', toDate: '2027-06-30', normalBalance: 'credit',
  };

  it('issues a single query however many boundaries the range holds', async () => {
    const { sql } = await import('@/lib/neon');
    const mocked = vi.mocked(sql);
    mocked.mockReset();
    mocked.mockResolvedValue([] as never);
    const boundaries = Array.from({ length: 300 }, (_, i) => `${1901 + i}-03-01`);
    await loadYearEndCloses({ ...scope, fromDate: '1900-01-01', toDate: '2200-12-31' }, '1900-03-01', boundaries);
    expect(mocked).toHaveBeenCalledTimes(1);
  }, 5000);

  it('derives each close from its bucket; an empty year has no close; positions follow line counts', async () => {
    const { sql } = await import('@/lib/neon');
    const mocked = vi.mocked(sql);
    mocked.mockReset();
    // bucket k = the year ending at boundary k. Bucket 2 (2026-03 .. 2027-03) holds nothing.
    mocked.mockResolvedValue([
      { bucket: 0, d: '0', c: '100', n: '2' },
      { bucket: 1, d: '20', c: '70', n: '1' },
    ] as never);
    const closes = await loadYearEndCloses(scope, '2024-03-01', ['2025-03-01', '2026-03-01', '2027-03-01']);
    expect(closes).toEqual([
      { boundary: '2025-03-01', balanceBefore: 100, position: 2 },
      { boundary: '2026-03-01', balanceBefore: 50, position: 4 },
    ]);
  }, 5000);

  it('keeps a bucket whose lines net to zero out of the closes but still counts its lines', async () => {
    const { sql } = await import('@/lib/neon');
    const mocked = vi.mocked(sql);
    mocked.mockReset();
    mocked.mockResolvedValue([
      { bucket: 0, d: '30', c: '30', n: '3' },
      { bucket: 1, d: '0', c: '9', n: '1' },
    ] as never);
    const closes = await loadYearEndCloses(scope, '2024-03-01', ['2025-03-01', '2026-03-01']);
    expect(closes).toEqual([{ boundary: '2026-03-01', balanceBefore: 9, position: 4 }]);
  }, 5000);
});
