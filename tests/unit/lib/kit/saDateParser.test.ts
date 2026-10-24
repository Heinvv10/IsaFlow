import { describe, it, expect, afterAll } from 'vitest';
import { parseSaDate, formatSaDate, formatSaDateLong } from '@/lib/saDateParser';

// SAST is UTC+2: pin it so a UTC-based "today" at 23:59 local is caught on any machine.
// Set at import, before any Date below is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Africa/Johannesburg';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// Thursday 15 Oct 2026, local time. Late evening on purpose: a UTC-based "today" would be wrong east of UTC.
const TODAY = new Date(2026, 9, 15, 23, 59, 30);

const ok = (input: string): string | null => {
  const r = parseSaDate(input, TODAY);
  return r.ok ? r.iso : null;
};

describe('parseSaDate accepts', () => {
  const accepted: Array<[string, string]> = [
    ['2026-10-01', '2026-10-01'],
    ['1 Oct 2026', '2026-10-01'],
    ['01 Oct 2026', '2026-10-01'],
    ['01 October 2026', '2026-10-01'],
    ['1-Oct-2026', '2026-10-01'],
    ['1 oct 2026', '2026-10-01'],
    ['1 SEPT 2026', '2026-09-01'],
    ['Oct 1 2026', '2026-10-01'],
    ['Oct 1, 2026', '2026-10-01'],
    ['01/10/2026', '2026-10-01'],
    ['1/10/2026', '2026-10-01'],
    ['01-10-2026', '2026-10-01'],
    ['01.10.2026', '2026-10-01'],
    ['31/12/2026', '2026-12-31'],
    ['29/02/2028', '2028-02-29'],
    ['01/10/26', '2026-10-01'],
    ['1 Oct', '2026-10-01'],
    ['  1 Oct 2026  ', '2026-10-01'],
    ['2026/10/01', '2026-10-01'],
  ];
  it.each(accepted)('%j -> %s', (input, iso) => {
    expect(ok(input)).toBe(iso);
  });

  it('dd/mm/yyyy is day first, never month first', () => {
    expect(ok('03/04/2026')).toBe('2026-04-03');
    expect(ok('12/11/2026')).toBe('2026-11-12');
  });
});

describe('parseSaDate shortcuts (relative to the local today)', () => {
  const shortcuts: Array<[string, string]> = [
    ['t', '2026-10-15'],
    ['T', '2026-10-15'],
    ['today', '2026-10-15'],
    ['+30', '2026-11-14'],
    ['+0', '2026-10-15'],
    ['+1', '2026-10-16'],
    ['-7', '2026-10-08'],
    ['-15', '2026-09-30'],
    ['+365', '2027-10-15'],
    ['eom', '2026-10-31'],
    ['EOM', '2026-10-31'],
  ];
  it.each(shortcuts)('%j -> %s', (input, iso) => {
    expect(ok(input)).toBe(iso);
  });

  it('eom handles February in a leap year and December', () => {
    expect(parseSaDate('eom', new Date(2028, 1, 3))).toEqual({ ok: true, iso: '2028-02-29' });
    expect(parseSaDate('eom', new Date(2027, 1, 3))).toEqual({ ok: true, iso: '2027-02-28' });
    expect(parseSaDate('eom', new Date(2026, 11, 3))).toEqual({ ok: true, iso: '2026-12-31' });
  });

  it('today is the LOCAL date at 23:59, not the UTC date', () => {
    const lateLocal = new Date(2026, 9, 15, 23, 59, 59);
    expect(parseSaDate('t', lateLocal)).toEqual({ ok: true, iso: '2026-10-15' });
    const justAfterMidnight = new Date(2026, 9, 16, 0, 0, 1);
    expect(parseSaDate('t', justAfterMidnight)).toEqual({ ok: true, iso: '2026-10-16' });
  });
});

describe('parseSaDate rejects with a reason', () => {
  const rejected: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['31/02/2026', 'invalid'],
    ['29/02/2027', 'invalid'],
    ['2026-02-30', 'invalid'],
    ['32 Oct 2026', 'invalid'],
    ['0 Oct 2026', 'invalid'],
    ['13/13/2026', 'invalid'],
    ['00/10/2026', 'invalid'],
    ['2026-13-01', 'invalid'],
    ['1 Foo 2026', 'format'],
    ['yesterday', 'format'],
    ['soon', 'format'],
    ['2026', 'format'],
    ['10/2026', 'format'],
    ['1/2/3/4', 'format'],
    ['+', 'format'],
    ['+abc', 'format'],
    ['1.5', 'format'],
    ['eom+1', 'format'],
    ['01/10/1850', 'range'],
    ['01/10/2300', 'range'],
    ['+99999999', 'range'],
  ];
  it.each(rejected)('%j -> %s', (input, code) => {
    const r = parseSaDate(input, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(r.reason.length).toBeGreaterThan(8);
    }
  });
});

describe('formatting', () => {
  it('formats dd MMM yyyy', () => {
    expect(formatSaDate('2026-10-01')).toBe('01 Oct 2026');
    expect(formatSaDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatSaDate('2026-05-09')).toBe('09 May 2026');
  });
  it('formats a long echo with the weekday', () => {
    expect(formatSaDateLong('2026-10-15')).toBe('Thursday, 15 October 2026');
    expect(formatSaDateLong('2026-10-01')).toBe('Thursday, 1 October 2026');
  });
  it('round-trips through the parser', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31', '1999-07-04']) {
      expect(parseSaDate(formatSaDate(iso), TODAY)).toEqual({ ok: true, iso });
    }
  });
  it('returns empty text for a malformed iso rather than throwing', () => {
    expect(formatSaDate('not-a-date')).toBe('');
    expect(formatSaDateLong('2026-02-30')).toBe('');
  });
});
