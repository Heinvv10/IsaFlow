import { describe, it, expect } from 'vitest';
import { checkPostingDate, currentFiscalYear, fiscalYearShortcut, type PeriodLite } from '@/lib/fiscalDateCheck';

const P = (fiscalYear: number, n: number, start: string, end: string, status: string, name = `P${n}`): PeriodLite =>
  ({ periodName: name, fiscalYear, periodNumber: n, startDate: start, endDate: end, status });
// FY 2026 = Mar 2025 .. Feb 2026 (closed), FY 2027 = Mar 2026 .. Feb 2027
const LASTDAY: Record<number, string> = { 1: '31', 2: '28', 3: '31', 4: '30', 5: '31', 6: '30', 7: '31', 8: '31', 9: '30', 10: '31', 11: '30', 12: '31' };
const MONTH_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
/** FY2027 = Mar 2026..Feb 2027, one period per month; Jan 2027 is not generated yet. */
const fy2027 = Array.from({ length: 12 }, (_, i) => {
  const m = ((i + 2) % 12) + 1; const y = m >= 3 ? 2026 : 2027;
  return P(2027, i + 1, `${y}-${pad(m)}-01`, `${y}-${pad(m)}-${LASTDAY[m]}`, 'open', `${MONTH_NAME[m - 1]} ${y}`);
}).filter((p) => p.startDate !== '2027-01-01')
  .map((p) => (p.periodName === 'Mar 2026' ? { ...p, status: 'closed' } : p.periodName === 'May 2026' ? { ...p, status: 'closing' } : p));
const PERIODS: PeriodLite[] = [
  P(2026, 11, '2026-01-01', '2026-01-31', 'locked', 'Jan 2026'),
  P(2026, 12, '2026-02-01', '2026-02-28', 'closed', 'Feb 2026'),
  ...fy2027,
];
const TODAY = '2026-11-22';
const check = (iso: string, periods = PERIODS) => checkPostingDate(iso, periods, TODAY, 3);

describe('checkPostingDate', () => {
  it('blocks a date in a closed or locked period and names the period and its state', () => {
    for (const [iso, name, state] of [['2026-03-15', 'Mar 2026', 'closed'], ['2026-01-31', 'Jan 2026', 'locked'], ['2026-02-28', 'Feb 2026', 'closed']] as const) {
      const r = check(iso);
      expect(r.level, iso).toBe('block');
      expect(r.code).toBe('closed-period');
      expect(r.message).toContain(name);
      expect(r.message).toContain(state);
    }
  });
  it('allows open periods', () => {
    expect(check('2026-04-10').level).toBeNull();
    expect(check('2026-11-22').level).toBeNull();
  });
  it('a closing period is treated like a closed one: the server refuses to post into it', () => {
    const r = check('2026-05-10');
    expect(r.level).toBe('block');
    expect(r.message).toContain('May 2026');
    expect(r.message).toContain('closing');
  });
  it('draftOnly: closed, locked and closing dates warn instead of blocking, and say a draft can still be saved', () => {
    for (const iso of ['2026-03-15', '2026-01-31', '2026-05-10']) {
      const r = checkPostingDate(iso, PERIODS, TODAY, 3, true);
      expect(r.level, iso).toBe('warn');
      expect(r.code).toBe('closed-period');
      expect(r.message).toMatch(/draft/i);
      expect(r.message).toMatch(/not.*posted|cannot be posted|can't be posted/i);
    }
    expect(checkPostingDate('2026-04-10', PERIODS, TODAY, 3, true).level).toBeNull();
  });
  it('period boundaries are inclusive', () => {
    expect(check('2026-03-01').level).toBe('block');
    expect(check('2026-03-31').level).toBe('block');
    expect(check('2026-04-01').level).toBeNull();
  });
  it('warns, without blocking, for a date outside the current financial year', () => {
    const before = check('2026-02-27', []);
    expect(before).toMatchObject({ level: 'warn', code: 'outside-fy' });
    expect(before.message).toMatch(/1 Mar 2026/);
    expect(before.message).toMatch(/28 Feb 2027/);
    expect(check('2027-03-01', []).level).toBe('warn');
    expect(check('2026-03-01', []).level).toBeNull();
    expect(check('2027-02-28', []).level).toBeNull();
  });
  it('a block wins over an outside-FY warning', () => {
    expect(check('2026-01-15').code).toBe('closed-period');
  });
  it('a date no period covers is not blocked (the period is created on posting)', () => {
    expect(check('2027-01-15').level).toBeNull();
  });
  it('before the periods have loaded nothing is blocked or warned', () => {
    expect(checkPostingDate('2020-01-01', null, TODAY, 3)).toEqual({ level: null, code: null, message: null });
  });
});

describe('currentFiscalYear', () => {
  it('uses the periods of the year that holds today when they exist', () => {
    expect(currentFiscalYear(PERIODS, TODAY, 3)).toEqual({ start: '2026-03-01', end: '2027-02-28' });
  });
  it('takes the year from the periods, not the start month, when they differ (short transition year)', () => {
    const short = [
      P(2099, 1, '2026-07-01', '2026-07-31', 'open', 'Jul 2026'),
      P(2099, 5, '2026-11-01', '2026-11-30', 'open', 'Nov 2026'),
      P(2099, 6, '2026-12-01', '2026-12-31', 'open', 'Dec 2026'),
    ];
    expect(currentFiscalYear(short, TODAY, 3)).toEqual({ start: '2026-07-01', end: '2026-12-31' });
  });
  it('falls back to the company financial-year month when no period holds today', () => {
    expect(currentFiscalYear([], TODAY, 3)).toEqual({ start: '2026-03-01', end: '2027-02-28' });
    expect(currentFiscalYear(null, '2026-02-10', 3)).toEqual({ start: '2025-03-01', end: '2026-02-28' });
    expect(currentFiscalYear([], TODAY, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});

describe('fiscalYearShortcut', () => {
  const fy = { start: '2026-03-01', end: '2027-02-28' };
  it('y is the first day of the financial year and r the last', () => {
    expect(fiscalYearShortcut('y', fy)).toBe('2026-03-01');
    expect(fiscalYearShortcut('R', fy)).toBe('2027-02-28');
    expect(fiscalYearShortcut(' y ', fy)).toBe('2026-03-01');
  });
  it('anything else is not a shortcut', () => {
    for (const t of ['yr', 'x', '', 'year', '1']) expect(fiscalYearShortcut(t, fy)).toBeNull();
  });
});
