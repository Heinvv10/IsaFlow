import { describe, it, expect } from 'vitest';
import { parseMonth, formatMonth } from '@/lib/monthParser';

const NOW = new Date('2026-11-22T10:00:00Z'); // 22 Nov 2026 in SAST
const ok = (t: string) => { const r = parseMonth(t, NOW); return r.ok ? r.ym : `refused: ${r.reason}`; };

describe('parseMonth', () => {
  it('reads the unambiguous forms', () => {
    expect(ok('2026-03')).toBe('2026-03');
    expect(ok('2026/3')).toBe('2026-03');
    expect(ok('03/2026')).toBe('2026-03');
    expect(ok('3-2026')).toBe('2026-03');
    expect(ok('3 2026')).toBe('2026-03');
    expect(ok('032026')).toBe('2026-03');
  });
  it('reads month names in English and Afrikaans, with a year or without', () => {
    expect(ok('Mar 2026')).toBe('2026-03');
    expect(ok('march 2026')).toBe('2026-03');
    expect(ok('Maart 2026')).toBe('2026-03');
    expect(ok('mrt 2026')).toBe('2026-03');
    expect(ok('sept 2025')).toBe('2025-09');
    expect(ok('feb')).toBe('2026-02');
    expect(ok('desember')).toBe('2026-12');
  });
  it('a two-digit year expands like the date parser', () => {
    expect(ok('mar 27')).toBe('2027-03');
    expect(ok('mar-99')).toBe('1999-03');
  });
  it('a bare number is a month of this year', () => {
    expect(ok('3')).toBe('2026-03');
    expect(ok('12')).toBe('2026-12');
  });
  it('t is this month; +N and -N count months from it', () => {
    expect(ok('t')).toBe('2026-11');
    expect(ok('today')).toBe('2026-11');
    expect(ok('-1')).toBe('2026-10');
    expect(ok('+2')).toBe('2027-01');
    expect(ok('-11')).toBe('2025-12');
  });
  it('refuses what is not a month, with a reason that shows the forms', () => {
    for (const t of ['13', '0', 'abc', '2026-13', '00/2026', 'ma', '32/2026', '1/20266']) {
      const r = parseMonth(t, NOW);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/month/i);
    }
  });
  it('refuses a year outside 1900-2100', () => {
    expect(ok('3/1800')).toMatch(/refused/);
    expect(ok('3/2101')).toMatch(/refused/);
  });
  it('follows the South African day, not the device clock', () => {
    // 23:30 UTC on 30 Nov is already 1 Dec in SAST
    expect(parseMonth('t', new Date('2026-11-30T23:30:00Z'))).toEqual({ ok: true, ym: '2026-12' });
  });
  it('formatMonth shows "Mar 2026" and nothing for junk', () => {
    expect(formatMonth('2026-03')).toBe('Mar 2026');
    expect(formatMonth('2026-12')).toBe('Dec 2026');
    expect(formatMonth('')).toBe('');
  });
});

import { addMonths, clampMonth } from '@/lib/monthParser';
describe('month arithmetic', () => {
  it('addMonths crosses years both ways', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-06', -18)).toBe('2024-12');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
  });
  it('clampMonth pins to the bounds', () => {
    expect(clampMonth('2026-01', '2026-03', '2026-09')).toBe('2026-03');
    expect(clampMonth('2026-12', '2026-03', '2026-09')).toBe('2026-09');
    expect(clampMonth('2026-05', '2026-03', '2026-09')).toBe('2026-05');
    expect(clampMonth('2026-05')).toBe('2026-05');
  });
});
