import { describe, it, expect } from 'vitest';
import { parseSaDate } from '@/lib/saDateParser';

// 23:59:30 SAST Thursday 15 Oct 2026; the parser must read this as 15 Oct whatever the device zone.
const NOW = new Date('2026-10-15T21:59:30Z');
const iso = (s: string, anchor?: string) => {
  const r = parseSaDate(s, NOW, anchor);
  return r.ok ? r.iso : `ERR:${r.code}`;
};

describe('parseSaDate short forms', () => {
  it('reads a bare day as that day of the current month', () => {
    expect(iso('15')).toBe('2026-10-15');
    expect(iso('1')).toBe('2026-10-01');
    expect(iso('31')).toBe('2026-10-31');
  });
  it('refuses a day the month does not have, and 0', () => {
    expect(iso('0')).toBe('ERR:invalid');
    expect(iso('32')).toBe('ERR:invalid');
    expect(parseSaDate('31', new Date('2026-11-10T10:00:00Z')).ok).toBe(false); // November has 30
  });
  it('reads day/month as this year, day first', () => {
    expect(iso('15/3')).toBe('2026-03-15');
    expect(iso('5-12')).toBe('2026-12-05');
  });
  it('does not read a decimal as a date', () => {
    expect(iso('1.5')).toBe('ERR:format');
    expect(iso('15.03')).toBe('ERR:format');
  });
  it('refuses a day/month that is not a real date, or month-first', () => {
    expect(iso('31/2')).toBe('ERR:invalid');
    expect(iso('3/15')).toBe('ERR:invalid');
  });
  it('reads eight digits as ddmmyyyy', () => {
    expect(iso('15032026')).toBe('2026-03-15');
    expect(iso('01102026')).toBe('2026-10-01');
    expect(iso('31022026')).toBe('ERR:invalid');
  });
  it('reads six digits as ddmmyy with the two-digit-year window', () => {
    expect(iso('150326')).toBe('2026-03-15');
    expect(iso('010146')).toBe('2046-01-01'); // within now + 20
    expect(iso('010147')).toBe('1947-01-01'); // beyond it reads as the last century
    expect(iso('261015')).toBe('2015-10-26'); // yymmdd is misread on purpose: day first is the rule
  });
  it('does not take 3, 5 or 7 digit runs, nor a signed bare number (that is the offset shortcut)', () => {
    expect(iso('150')).toBe('ERR:format');
    expect(iso('15032')).toBe('ERR:format');
    expect(iso('1503202')).toBe('ERR:format');
    expect(iso('+15')).toBe('2026-10-30');
  });
  it('keeps the existing forms exactly', () => {
    expect(iso('15/03/2026')).toBe('2026-03-15');
    expect(iso('2026-03-15')).toBe('2026-03-15');
    expect(iso('1 Oct')).toBe('2026-10-01');
    expect(iso('t')).toBe('2026-10-15');
    expect(iso('eom')).toBe('2026-10-31');
  });
  it('a bare day is counted in the SAST month, not the device month', () => {
    // 22:30Z on 31 Oct is 00:30 SAST on 1 Nov
    const r = parseSaDate('15', new Date('2026-10-31T22:30:00Z'));
    expect(r.ok && r.iso).toBe('2026-11-15');
  });
});
