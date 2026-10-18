/**
 * G-06: a reversed closing journal is not a close, and the year is closed again under the next
 * free number. `reverseJournalEntry` leaves `status = 'posted'` and sets only `reversed_at`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findClosingJournal = vi.fn();
vi.mock('@/modules/accounting/services/gl/yearEndJournalPoster', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findClosingJournal: (...a: unknown[]) => findClosingJournal(...a),
}));
const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ClosingChainTooLong, findCurrentClosingJournal, reclosingNumber, TooManyRecloses } from '@/modules/accounting/services/gl/yearEndClosingNumber';
import { classifyClosingJournal } from '@/modules/accounting/services/gl/yearEndJournalPoster';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const closed = (n: string, reversedAt: string | null) =>
  ({ id: `id-${n}`, entry_number: n, source: 'year_end', status: 'posted', reversed_at: reversedAt });

/** The posted reversals in force on each journal the walk asks about, in call order: n entries = n links. */
const chain = (links: number[]) => {
  const queue = links.flatMap((n) => [...Array.from({ length: n }, (_, i) => [{ id: `r${i}` }]), []]);
  sqlMock.mockImplementation(async () => queue.shift() ?? []);
};

beforeEach(() => { findClosingJournal.mockReset(); sqlMock.mockReset(); chain([]); });

describe('classifyClosingJournal', () => {
  it('a posted, unreversed year_end journal is the close', () => {
    expect(classifyClosingJournal('YE-2025', closed('YE-2025', null))).toBeNull();
  });

  it('a posted year_end journal with reversed_at set is NOT a close', () => {
    expect(classifyClosingJournal('YE-2025', closed('YE-2025', '2026-03-01T10:00:00Z'))).toEqual({
      error: 'closing_journal_not_posted', entryNumber: 'YE-2025', entryId: 'id-YE-2025', status: 'reversed',
    });
  });

  it('a legacy status=reversed row still refuses with its own status', () => {
    const row = { ...closed('YE-2025', null), status: 'reversed' };
    expect(classifyClosingJournal('YE-2025', row)).toMatchObject({ error: 'closing_journal_not_posted', status: 'reversed' });
  });
});

describe('findCurrentClosingJournal', () => {
  it('names the re-closes YE-<year>-R<n>', () => {
    expect([0, 1, 2].map((n) => reclosingNumber('YE-2025', n))).toEqual(['YE-2025', 'YE-2025-R1', 'YE-2025-R2']);
  });

  it('a free base number is used as is', async () => {
    findClosingJournal.mockResolvedValueOnce(null);
    expect(await findCurrentClosingJournal(COMPANY, 'YE-2025')).toEqual({ entryNumber: 'YE-2025', existing: null });
  });

  it('a live close is returned as the existing close', async () => {
    const row = closed('YE-2025', null);
    findClosingJournal.mockResolvedValueOnce(row);
    expect(await findCurrentClosingJournal(COMPANY, 'YE-2025')).toEqual({ entryNumber: 'YE-2025', existing: row });
  });

  it('walks past reversed closes to the first free number', async () => {
    chain([1, 1]);
    findClosingJournal
      .mockResolvedValueOnce(closed('YE-2025', '2026-03-01T10:00:00Z'))
      .mockResolvedValueOnce(closed('YE-2025-R1', '2026-04-01T10:00:00Z'))
      .mockResolvedValueOnce(null);
    expect(await findCurrentClosingJournal(COMPANY, 'YE-2025')).toEqual({ entryNumber: 'YE-2025-R2', existing: null });
    expect(findClosingJournal.mock.calls.map((c) => c[1])).toEqual(['YE-2025', 'YE-2025-R1', 'YE-2025-R2']);
  });

  it('stops at a draft or a squatter: they hold the number and are classified, not skipped', async () => {
    const draft = { ...closed('YE-2025', null), status: 'draft' };
    findClosingJournal.mockResolvedValueOnce(draft);
    expect(await findCurrentClosingJournal(COMPANY, 'YE-2025')).toEqual({ entryNumber: 'YE-2025', existing: draft });
    const squatter = { ...closed('YE-2025', '2026-03-01T10:00:00Z'), source: 'manual' };
    findClosingJournal.mockResolvedValueOnce(squatter);
    expect((await findCurrentClosingJournal(COMPANY, 'YE-2025')).existing).toBe(squatter);
  });

  it('a close whose reversal was itself reversed stands: it is returned, flagged reinstated, and classifies as closed', async () => {
    chain([2]);
    findClosingJournal.mockResolvedValueOnce(closed('YE-2025', '2026-03-01T10:00:00Z'));
    const found = await findCurrentClosingJournal(COMPANY, 'YE-2025');
    expect(found.entryNumber).toBe('YE-2025');
    expect(found.existing).toMatchObject({ id: 'id-YE-2025', reinstated: true });
    expect(classifyClosingJournal('YE-2025', found.existing!)).toBeNull();
  });

  it('a reversal claim with no contra reads as standing, as journalStandsFragment does', async () => {
    chain([0]);
    findClosingJournal.mockResolvedValueOnce(closed('YE-2025', '2026-03-01T10:00:00Z'));
    expect((await findCurrentClosingJournal(COMPANY, 'YE-2025')).existing).toMatchObject({ reinstated: true });
  });

  it('refuses a loop with a typed error rather than walking forever', async () => {
    let n = 0;
    sqlMock.mockImplementation(async () => (n++ % 2 === 0 ? [{ id: 'r' }] : []));
    findClosingJournal.mockImplementation(async (_c: string, num: string) => closed(num, '2026-03-01T10:00:00Z'));
    await expect(findCurrentClosingJournal(COMPANY, 'YE-2025')).rejects.toBeInstanceOf(TooManyRecloses);
  });

  it('refuses a reversal chain longer than it will read instead of guessing it stands', async () => {
    sqlMock.mockImplementation(async () => [{ id: 'next' }]);
    findClosingJournal.mockResolvedValueOnce(closed('YE-2025', '2026-03-01T10:00:00Z'));
    await expect(findCurrentClosingJournal(COMPANY, 'YE-2025')).rejects.toBeInstanceOf(ClosingChainTooLong);
  });
});
