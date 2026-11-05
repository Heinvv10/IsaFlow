import { describe, it, expect } from 'vitest';
import { agoText, maskedNumber } from '@/components/payroll/employeeCreate/bankDetails';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('agoText (fixed now)', () => {
  it.each([
    [0, 'just now'], [30_000, 'just now'], [MIN, '1 minute ago'], [5 * MIN, '5 minutes ago'], [59 * MIN, '59 minutes ago'],
    [HOUR, '1 hour ago'], [3 * HOUR, '3 hours ago'], [23 * HOUR, '23 hours ago'],
    [DAY, '1 day ago'], [2 * DAY + MIN, '2 days ago'], [29 * DAY, '29 days ago'],
  ])('%d ms back reads %s', (ms, text) => expect(agoText(before(ms), NOW)).toBe(text));

  it('from 30 days it is the date', () => expect(agoText(before(30 * DAY), NOW)).toMatch(/^on \d{1,2} \w{3} 2026$/));
  it('a future time is just now, and rubbish is empty', () => {
    expect(agoText(before(-HOUR), NOW)).toBe('just now');
    expect(agoText('nope', NOW)).toBe('');
  });
});

describe('maskedNumber', () => {
  it.each([['…1234', '•••• 1234'], ['••••', '••••'], ['62000123456', '62000123456']])('%s -> %s', (i, o) => expect(maskedNumber(i)).toBe(o));
});
