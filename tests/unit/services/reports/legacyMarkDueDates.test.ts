/**
 * A mark made before migration 999c has no period and matches a calendar item only on (type, due date). Due dates
 * now also move off public holidays, so such a mark may be stored under the OLD weekend-only date: it must still
 * match the item, and an unrelated date must not.
 */
import { describe, expect, it } from 'vitest';
import { legacyDueDates, weekendOnlyPreviousDay } from '@/modules/accounting/services/reports/legacyMarkDueDates';

describe('weekendOnlyPreviousDay (legacy match only)', () => {
  it('moves a Saturday or Sunday back to Friday and leaves a holiday weekday alone', () => {
    expect(weekendOnlyPreviousDay('2026-04-25')).toBe('2026-04-24');
    expect(weekendOnlyPreviousDay('2026-10-25')).toBe('2026-10-23');
    expect(weekendOnlyPreviousDay('2026-12-25')).toBe('2026-12-25'); // Christmas, a Friday: the old rule kept it
  });
});

describe('legacyDueDates: the stored due dates an old mark may carry for an item now due on `due`', () => {
  it('a plain business day: only itself', () => {
    expect(legacyDueDates('2026-06-25')).toEqual(['2026-06-25']);
  });

  it('Christmas 2026: the item is now due Thu 24 Dec; the old date was Fri 25 Dec', () => {
    expect(legacyDueDates('2026-12-24')).toEqual(['2026-12-24', '2026-12-25']);
  });

  it('Easter 2023: EMP201 now due Thu 6 Apr; the old date was Fri 7 Apr (Good Friday)', () => {
    expect(legacyDueDates('2023-04-06')).toContain('2023-04-07');
  });

  it('Easter Monday 2026 (6 Apr): nominal Mon 6 Apr -> old date Mon 6 Apr; nominal Sat 4 / Sun 5 Apr -> old Fri 3 Apr', () => {
    const d = legacyDueDates('2026-04-02'); // Thu before Good Friday 3 Apr
    expect(d).toEqual(expect.arrayContaining(['2026-04-02', '2026-04-03', '2026-04-06']));
  });

  it('an unrelated date is not in the list', () => {
    expect(legacyDueDates('2026-12-24')).not.toContain('2026-12-23');
    expect(legacyDueDates('2026-12-24')).not.toContain('2027-01-25');
  });
});
