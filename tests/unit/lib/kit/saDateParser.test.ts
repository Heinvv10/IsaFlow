import { describe, it, expect, afterAll } from 'vitest';
import { parseSaDate, todayInSast, assertISODate } from '@/lib/saDateParser';
import { localDateFromISO } from '@/lib/dateUtils';
import { formatDisplayDate, formatDisplayDateWeekday } from '@/utils/dateFormat';

// The parser must not depend on the device's zone: run it in one far from SAST (UTC-8 / -7).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 23:59:30 SAST on Thursday 15 Oct 2026 is 21:59:30Z: still the 15th in South Africa.
const TODAY = new Date('2026-10-15T21:59:30Z');

const ok = (input: string, now: Date = TODAY): string | null => {
  const r = parseSaDate(input, now);
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

describe('Afrikaans month names', () => {
  const afrikaans: Array<[string, string]> = [
    ['1 Januarie 2026', '2026-01-01'],
    ['1 Feb 2026', '2026-02-01'],
    ['1 Februarie 2026', '2026-02-01'],
    ['1 Maart 2026', '2026-03-01'],
    ['1 Mrt 2026', '2026-03-01'],
    ['1 Mei 2026', '2026-05-01'],
    ['1 Junie 2026', '2026-06-01'],
    ['1 Julie 2026', '2026-07-01'],
    ['1 Aug 2026', '2026-08-01'],
    ['1 Augustus 2026', '2026-08-01'],
    ['1 Okt 2026', '2026-10-01'],
    ['1 Oktober 2026', '2026-10-01'],
    ['1 Des 2026', '2026-12-01'],
    ['1 Desember 2026', '2026-12-01'],
    ['Okt 1 2026', '2026-10-01'],
    ['15 mei', '2026-05-15'],
  ];
  it.each(afrikaans)('%j -> %s', (input, iso) => {
    expect(ok(input)).toBe(iso);
  });

  it('every month, English and Afrikaans, full and three-letter, lands on the same month', () => {
    const names: string[][] = [
      ['jan', 'january', 'januarie'], ['feb', 'february', 'februarie'], ['mar', 'march', 'maart'],
      ['apr', 'april'], ['may', 'mei'], ['jun', 'june', 'junie'], ['jul', 'july', 'julie'],
      ['aug', 'august', 'augustus'], ['sep', 'september'], ['oct', 'october', 'okt', 'oktober'],
      ['nov', 'november'], ['dec', 'december', 'des', 'desember'],
    ];
    names.forEach((variants, i) => {
      for (const name of variants) {
        expect(ok(`5 ${name} 2026`), name).toBe(`2026-${String(i + 1).padStart(2, '0')}-05`);
      }
    });
  });

  it('does not treat a non-month as one', () => {
    expect(ok('1 Foo 2026')).toBeNull();
    expect(ok('1 Ma 2026')).toBeNull();
  });
});

describe('two-digit years pivot (now + 20)', () => {
  it('2026: up to 2046 is this century, 2047 and later is the last', () => {
    expect(ok('01/10/26')).toBe('2026-10-01');
    expect(ok('01/10/46')).toBe('2046-10-01');
    expect(ok('01/10/47')).toBe('1947-10-01');
    expect(ok('01/10/99')).toBe('1999-10-01');
    expect(ok('01/10/00')).toBe('2000-10-01');
    expect(ok('1 Oct 99')).toBe('1999-10-01');
  });
  it('the window moves with the clock: in 2090, 99 is 2099 and 05 is 2005', () => {
    const later = new Date('2090-06-01T10:00:00Z');
    expect(ok('01/10/99', later)).toBe('2099-10-01');
    expect(ok('01/10/05', later)).toBe('2005-10-01');
    expect(ok('01/10/20', later)).toBe('2020-10-01');
    expect(ok('01/10/11', later)).toBe('2011-10-01');
  });
  it('four-digit years are never pivoted', () => {
    expect(ok('01/10/1999')).toBe('1999-10-01');
    expect(ok('01/10/2099')).toBe('2099-10-01');
  });
});

describe('today is the South African day, whatever the device zone', () => {
  it('t, today, +N, -N, eom at 23:59 SAST (21:59Z) are still the 15th', () => {
    expect(ok('t')).toBe('2026-10-15');
    expect(ok('today')).toBe('2026-10-15');
    expect(ok('+0')).toBe('2026-10-15');
    expect(ok('eom')).toBe('2026-10-31');
  });
  it('one second after SAST midnight (22:00:01Z) is the 16th', () => {
    const next = new Date('2026-10-15T22:00:01Z');
    expect(ok('t', next)).toBe('2026-10-16');
    expect(ok('+1', next)).toBe('2026-10-17');
    expect(ok('-1', next)).toBe('2026-10-15');
  });
  it('the device zone (here Los Angeles, where it is still the 15th at 05:00Z the 16th) does not matter', () => {
    const lateInSast = new Date('2026-10-16T05:00:00Z');
    expect(ok('t', lateInSast)).toBe('2026-10-16');
    expect(todayInSast(lateInSast)).toBe('2026-10-16');
  });
  it('month end follows the SAST month, including the turn of the month', () => {
    expect(ok('eom', new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-31');
    expect(ok('eom', new Date('2028-02-03T10:00:00Z'))).toBe('2028-02-29');
    expect(ok('eom', new Date('2027-02-03T10:00:00Z'))).toBe('2027-02-28');
    expect(ok('eom', new Date('2026-12-03T10:00:00Z'))).toBe('2026-12-31');
  });
  it('"1 Oct" takes the SAST year at New Year', () => {
    expect(ok('1 Oct', new Date('2026-12-31T22:30:00Z'))).toBe('2027-10-01');
  });
});

describe('parseSaDate shortcuts', () => {
  const shortcuts: Array<[string, string]> = [
    ['t', '2026-10-15'],
    ['T', '2026-10-15'],
    ['+30', '2026-11-14'],
    ['+1', '2026-10-16'],
    ['-7', '2026-10-08'],
    ['-15', '2026-09-30'],
    ['+365', '2027-10-15'],
    ['EOM', '2026-10-31'],
  ];
  it.each(shortcuts)('%j -> %s', (input, iso) => {
    expect(ok(input)).toBe(iso);
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

describe('the parser only parses: display is the canonical formatter', () => {
  it('whatever formatDisplayDate prints for a day of 2026 parses back to that day', () => {
    for (let m = 0; m < 12; m += 1) {
      for (const day of [1, 15, 28]) {
        const d = new Date(2026, m, day);
        const iso = `2026-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        expect(ok(formatDisplayDate(d)), formatDisplayDate(d)).toBe(iso);
      }
    }
  });
  it('the weekday echo is the canonical long form with the weekday', () => {
    expect(formatDisplayDateWeekday(localDateFromISO('2026-10-15'))).toBe('Thursday, 15 October 2026');
  });
});

describe('assertISODate', () => {
  it('accepts a real date and throws a RangeError naming the bound otherwise', () => {
    expect(() => assertISODate('2026-02-28', 'minDate')).not.toThrow();
    for (const bad of ['2026-2-1', '01/02/2026', '2026-02-30', '', 'yesterday', '0999-01-01']) {
      expect(() => assertISODate(bad, 'minDate')).toThrow(RangeError);
    }
    expect(() => assertISODate('x', 'maxDate')).toThrow(/maxDate/);
  });
});

describe('localDateFromISO', () => {
  it('is a LOCAL date, so the displayed day never shifts', () => {
    const d = localDateFromISO('2026-10-01');
    expect([d?.getFullYear(), d?.getMonth(), d?.getDate()]).toEqual([2026, 9, 1]);
    expect(localDateFromISO('2026-02-30')).toBeNull();
    expect(localDateFromISO('nope')).toBeNull();
  });
});
