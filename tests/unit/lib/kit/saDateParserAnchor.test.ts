import { describe, it, expect } from 'vitest';
import { parseSaDate } from '@/lib/saDateParser';

// 10:00 SAST on Thursday 15 Oct 2026.
const TODAY = new Date('2026-10-15T08:00:00Z');
const iso = (input: string, anchor?: string | null): string | null => {
  const r = parseSaDate(input, TODAY, anchor);
  return r.ok ? r.iso : null;
};

describe('parseSaDate with an anchor', () => {
  it('eom is the end of the anchor month: 1 Sep 2026 + eom = 30 Sep 2026', () => {
    expect(iso('eom', '2026-09-01')).toBe('2026-09-30');
    expect(iso('EOM', '2028-02-10')).toBe('2028-02-29');
  });

  it('without an anchor, eom is the end of this month (SAST)', () => {
    expect(iso('eom')).toBe('2026-10-31');
    expect(iso('eom', null)).toBe('2026-10-31');
  });

  it('+N and -N count from the anchor (a due date from the invoice date)', () => {
    expect(iso('+30', '2026-09-01')).toBe('2026-10-01');
    expect(iso('-1', '2026-03-01')).toBe('2026-02-28');
    expect(iso('+30')).toBe('2026-11-14');
  });

  it('t is always today, whatever the anchor', () => {
    expect(iso('t', '2026-09-01')).toBe('2026-10-15');
  });

  it('an anchor that is empty or not a real date is ignored', () => {
    expect(iso('eom', '')).toBe('2026-10-31');
    expect(iso('eom', '2026-02-30')).toBe('2026-10-31');
    expect(iso('+1', 'garbage')).toBe('2026-10-16');
  });

  it('a +N too far says what it counts from: today, or the anchor date itself', () => {
    const reason = (input: string, anchor?: string): string => {
      const r = parseSaDate(input, TODAY, anchor);
      return r.ok ? '' : r.reason;
    };
    expect(reason('+99999')).toBe('That is too many days from today.');
    expect(reason('+99999', '2026-09-01')).toBe('That is too many days from 01 Sep 2026.');
  });

  it('an explicit date ignores the anchor', () => {
    expect(iso('1 Oct 2026', '2025-01-01')).toBe('2026-10-01');
  });
});
