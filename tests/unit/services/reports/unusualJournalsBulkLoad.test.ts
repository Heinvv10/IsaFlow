/**
 * A LEDGER RELOADED IN BULK IS NOT NINETEEN THOUSAND BACKDATED JOURNALS.
 *
 * Velocity Fibre's books were rebuilt from source documents in September
 * 2026: 18 462 journals dated April 2025 to August 2026 were recorded between
 * 5 and 18 September, 7 556 of them on the 5th alone. The backdating rule —
 * recorded more than five days after its date — fired on almost every one,
 * and the board pack printed "19588 matters require a board decision".
 *
 * Nothing on the journal marks a reload: no import batch, a `source` of
 * `auto_bank_recon` or `auto_supplier_invoice` like any day's posting. What
 * marks it is WHEN it was recorded. On the four tenants of the production
 * copy, a day that recorded backdated journals recorded either one (ISAFlow
 * Demo's 4 July and 28 August, Brightsphere's 31 August) or thirteen and up
 * (every Velocity reload day; Brightsphere's and the demo's own imports). So a
 * day on which the company recorded ten or more backdated journals is a bulk
 * load, and its journals are not tested for late recording — counted, and
 * handed back so the pack can say what it skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { BULK_LOAD_MIN, getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const WINDOW = { start: '2026-01-01', end: '2026-10-02' };

interface WindowRow {
  id: string;
  entry_number: string | null;
  entry_date: string;
  description: string | null;
  created_at: Date;
  amount: number;
}
interface DayRow { entry_date: string; created_at: Date }

/** A journal dated in the window, recorded at `created`, for a sum that is
 *  not round — so only the backdating rule can flag it. */
function journal(id: string, entryDate: string, created: string, amount = 12_345.67): WindowRow {
  return { id, entry_number: `JE-${id}`, entry_date: entryDate, description: 'Supplier invoice', created_at: new Date(created), amount };
}

/** `n` journals the company recorded at `created`, each dated `entryDate`. */
function recorded(n: number, entryDate: string, created: string): DayRow[] {
  return Array.from({ length: n }, () => ({ entry_date: entryDate, created_at: new Date(created) }));
}

/** The window's rows, then the company's journals recorded on the days those
 *  rows were recorded. */
async function run(windowRows: WindowRow[], dayRows: DayRow[]) {
  sqlSpy.mockResolvedValueOnce(windowRows).mockResolvedValueOnce(dayRows);
  return getUnusualJournals(COMPANY, WINDOW);
}

beforeEach(() => {
  sqlSpy.mockReset();
});

describe('a day that recorded a bulk load', () => {
  it('is not read as backdating, and what it skipped is counted', async () => {
    // Velocity's 5 September: thirty journals in the window, dated January to
    // August, all recorded that morning — among 7 556 recorded that day.
    const rows = Array.from({ length: 30 }, (_, i) =>
      journal(`v${i}`, `2026-0${(i % 8) + 1}-15`, '2026-09-05T07:30:00.000Z'));
    const result = await run(rows, recorded(7_556, '2026-03-15', '2026-09-05T07:30:00.000Z'));

    expect(result.flags).toEqual([]);
    expect(result.bulkLoaded).toEqual({
      journals: 30, days: 1, firstRecorded: '2026-09-05', lastRecorded: '2026-09-05', oldestEntryDate: '2026-01-15',
    });
  });

  it('is decided at the threshold — nine backdated journals on a day are each a matter, ten are a load', async () => {
    expect(BULK_LOAD_MIN).toBe(10);
    const late = journal('a', '2026-03-01', '2026-04-20T09:00:00.000Z');

    const nine = await run([late], recorded(BULK_LOAD_MIN - 1, '2026-03-01', '2026-04-20T09:00:00.000Z'));
    expect(nine.flags.map((f) => [f.entryId, f.reason])).toEqual([['a', 'backdated']]);
    expect(nine.bulkLoaded).toBeNull();

    const ten = await run([late], recorded(BULK_LOAD_MIN, '2026-03-01', '2026-04-20T09:00:00.000Z'));
    expect(ten.flags).toEqual([]);
    expect(ten.bulkLoaded).toEqual({
      journals: 1, days: 1, firstRecorded: '2026-04-20', lastRecorded: '2026-04-20', oldestEntryDate: '2026-03-01',
    });
  });

  it('counts the company\'s whole day, not only the journals that fall in the window', async () => {
    // A monthly pack sees two of a reload's journals; the reload recorded
    // forty that day, the rest dated before the window opened.
    const rows = [
      journal('a', '2026-08-03', '2026-09-09T08:00:00.000Z'),
      journal('b', '2026-08-04', '2026-09-09T08:05:00.000Z'),
    ];
    const result = await run(rows, recorded(40, '2025-06-30', '2026-09-09T08:00:00.000Z'));
    expect(result.flags).toEqual([]);
    expect(result.bulkLoaded?.journals).toBe(2);
  });

  it('counts only BACKDATED journals toward the threshold', async () => {
    // A busy day of ordinary, same-day postings is not a reload: fifty
    // journals recorded on the day they are dated, and one late one.
    const late = journal('a', '2026-03-01', '2026-03-20T09:00:00.000Z');
    const result = await run([late], [
      ...recorded(50, '2026-03-20', '2026-03-20T09:00:00.000Z'),
      ...recorded(1, '2026-03-01', '2026-03-20T09:00:00.000Z'),
    ]);
    expect(result.flags.map((f) => f.reason)).toEqual(['backdated']);
    expect(result.bulkLoaded).toBeNull();
  });

  it('groups by the South African calendar day the journal was recorded on', async () => {
    // 22:30 UTC on the 5th is 00:30 on the 6th in Johannesburg. Ten recorded
    // late on the 5th (UTC) belong to the 6th, where the window's journal is.
    const late = journal('a', '2026-08-01', '2026-09-06T06:00:00.000Z');
    const sixth = await run([late], recorded(10, '2026-08-01', '2026-09-05T22:30:00.000Z'));
    expect(sixth.flags).toEqual([]);

    // And 21:30 UTC is still the 5th, a different day from the window's.
    const fifth = await run([late], recorded(10, '2026-08-01', '2026-09-05T21:30:00.000Z'));
    expect(fifth.flags.map((f) => f.reason)).toEqual(['backdated']);
  });

  it('spans the days it found, first to last', async () => {
    const rows = [
      journal('a', '2026-02-01', '2026-09-05T07:00:00.000Z'),
      journal('b', '2026-03-01', '2026-09-18T07:00:00.000Z'),
      journal('c', '2026-04-01', '2026-09-11T07:00:00.000Z'),
    ];
    const result = await run(rows, [
      ...recorded(12, '2026-02-01', '2026-09-05T07:00:00.000Z'),
      ...recorded(12, '2026-02-01', '2026-09-11T07:00:00.000Z'),
      ...recorded(12, '2026-02-01', '2026-09-18T07:00:00.000Z'),
    ]);
    expect(result.bulkLoaded).toEqual({
      journals: 3, days: 3, firstRecorded: '2026-09-05', lastRecorded: '2026-09-18', oldestEntryDate: '2026-02-01',
    });
  });
});

describe('what a bulk load does not excuse', () => {
  it('a journal backdated into a reported quarter among routine late captures is carried in the load\'s oldest date', async () => {
    // Nine August invoices captured late on 10 September, and one R487 312.55
    // journal dated 31 March: ten on the day, so a load — and the load's
    // oldest date is the March one, which page 11 prints.
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => journal(`aug${i}`, '2026-08-20', '2026-09-10T08:00:00.000Z')),
      journal('q1', '2026-03-31', '2026-09-10T09:00:00.000Z', 487_312.55),
    ];
    const result = await run(rows, recorded(10, '2026-08-20', '2026-09-10T08:00:00.000Z'));
    expect(result.bulkLoaded).toMatchObject({ journals: 10, oldestEntryDate: '2026-03-31' });
  });

  it('dates the load by its OWN journals, not by an older late journal recorded on an ordinary day', async () => {
    const rows = [
      journal('loaded', '2026-05-01', '2026-09-05T07:00:00.000Z'),
      // Late, older, and alone on its recording day: a matter of its own.
      journal('alone', '2026-01-15', '2026-02-20T07:00:00.000Z'),
    ];
    const result = await run(rows, [
      ...recorded(20, '2026-05-01', '2026-09-05T07:00:00.000Z'),
      ...recorded(1, '2026-01-15', '2026-02-20T07:00:00.000Z'),
    ]);
    expect(result.bulkLoaded).toMatchObject({ journals: 1, oldestEntryDate: '2026-05-01' });
    expect(result.flags.map((f) => [f.entryId, f.reason])).toEqual([['alone', 'backdated']]);
  });

  it('a round number recorded in a bulk load is still a round number, and is not counted as skipped', async () => {
    const round = journal('r', '2026-03-01', '2026-09-05T07:00:00.000Z', 6_000_000);
    const plain = journal('p', '2026-03-02', '2026-09-05T07:00:00.000Z');
    const result = await run([round, plain], recorded(100, '2026-03-01', '2026-09-05T07:00:00.000Z'));
    expect(result.flags.map((f) => [f.entryId, f.reason])).toEqual([['r', 'round_number']]);
    expect(result.bulkLoaded?.journals).toBe(1);
  });

  it('a late journal recorded on an ordinary day is still a matter beside a load on another day', async () => {
    const loaded = journal('l', '2026-03-01', '2026-09-05T07:00:00.000Z');
    const alone = journal('x', '2026-07-01', '2026-07-04T07:00:00.000Z');
    const lateAlone = journal('y', '2026-06-01', '2026-08-28T07:00:00.000Z');
    const result = await run([loaded, alone, lateAlone], [
      ...recorded(20, '2026-03-01', '2026-09-05T07:00:00.000Z'),
      ...recorded(1, '2026-06-01', '2026-08-28T07:00:00.000Z'),
    ]);
    expect(result.flags.map((f) => [f.entryId, f.reason])).toEqual([['y', 'backdated']]);
    expect(result.bulkLoaded?.journals).toBe(1);
  });
});

describe('the second read', () => {
  it('is not made when nothing in the window was recorded late', async () => {
    sqlSpy.mockResolvedValueOnce([journal('a', '2026-03-10', '2026-03-10T08:00:00.000Z', 40_000)]);
    const result = await getUnusualJournals(COMPANY, WINDOW);
    expect(sqlSpy).toHaveBeenCalledTimes(1);
    expect(result.bulkLoaded).toBeNull();
  });

  it('binds the company and the recording days it asks about', async () => {
    await run([
      journal('a', '2026-03-01', '2026-09-05T07:00:00.000Z'),
      journal('b', '2026-03-01', '2026-09-05T08:00:00.000Z'),
      journal('c', '2026-03-01', '2026-09-05T23:00:00.000Z'),
    ], []);
    expect(sqlSpy).toHaveBeenCalledTimes(2);
    const values = sqlSpy.mock.calls[1]!.slice(1);
    expect(values).toContain(COMPANY);
    // Two SAST days — the 23:00 UTC journal was recorded on the 6th — each once.
    expect(values).toContainEqual(['2026-09-05', '2026-09-06']);
  });
});

describe('a journal with no recording time', () => {
  // `created_at` is nullable (migration 200 gives a default, not NOT NULL).
  // Such a journal cannot be shown to be late, and must not throw: a throw
  // here is not a failed read, so it would take the whole pack down.
  it('is not backdated, does not throw, and is still tested as a round number', async () => {
    sqlSpy.mockResolvedValueOnce([
      { id: 'n', entry_number: 'JE-n', entry_date: '2026-03-31', description: null, created_at: null, amount: 12_345.67 },
      { id: 'r', entry_number: 'JE-r', entry_date: '2026-03-31', description: null, created_at: null, amount: 50_000 },
    ]);
    const result = await getUnusualJournals(COMPANY, WINDOW);
    expect(result.flags.map((f) => [f.entryId, f.reason])).toEqual([['r', 'round_number']]);
    expect(result.bulkLoaded).toBeNull();
    expect(sqlSpy).toHaveBeenCalledTimes(1);
  });
});

