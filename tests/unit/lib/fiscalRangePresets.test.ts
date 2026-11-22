import { describe, it, expect } from 'vitest';
import { fiscalRangePresets, presetRange, matchPreset, FY_PRESET_KEYS, asAtPresetDate, AS_AT_PRESET_KEYS } from '@/lib/fiscalRangePresets';

// FY starting March: 1 Mar 2026 -> 28 Feb 2027
describe('fiscalRangePresets (FY starts March)', () => {
  const today = '2026-11-22';
  const r = (k: Parameters<typeof presetRange>[0]) => presetRange(k, today, 3);
  it('this month / last month', () => {
    expect(r('this_month')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(r('last_month')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
  it('last month across a year boundary', () => {
    expect(presetRange('last_month', '2026-01-10', 3)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('quarters are financial-year quarters (Sep-Nov for a March FY)', () => {
    expect(r('this_quarter')).toEqual({ from: '2026-09-01', to: '2026-11-30' });
    expect(r('last_quarter')).toEqual({ from: '2026-06-01', to: '2026-08-31' });
  });
  it('this FY / FY to date / last FY', () => {
    expect(r('this_fy')).toEqual({ from: '2026-03-01', to: '2027-02-28' });
    expect(r('fy_to_date')).toEqual({ from: '2026-03-01', to: today });
    expect(r('last_fy')).toEqual({ from: '2025-03-01', to: '2026-02-28' });
  });
  it('FY containing a leap day ends 29 Feb', () => {
    expect(presetRange('this_fy', '2027-06-01', 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
  it('before the FY start month, the FY began last calendar year', () => {
    expect(presetRange('this_fy', '2026-02-15', 3)).toEqual({ from: '2025-03-01', to: '2026-02-28' });
  });
  it('in the FY start month itself, the FY starts this year', () => {
    expect(presetRange('this_fy', '2026-03-10', 3)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
    expect(presetRange('last_fy', '2026-03-10', 3)).toEqual({ from: '2025-03-01', to: '2026-02-28' });
  });
  it('January start is the calendar year', () => {
    expect(presetRange('this_fy', today, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetRange('last_fy', today, 1)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
  it('last 30 days is inclusive of today', () => {
    expect(r('last_30_days')).toEqual({ from: '2026-10-24', to: today });
  });
  it('custom has no range; every key listed once', () => {
    expect(r('custom')).toBeNull();
    expect(new Set(FY_PRESET_KEYS).size).toBe(FY_PRESET_KEYS.length);
    expect(fiscalRangePresets(today, 3).map(p => p.key)).toEqual(FY_PRESET_KEYS.filter(k => k !== 'custom'));
  });
  it('an invalid FY month throws instead of guessing', () => {
    expect(() => presetRange('this_fy', today, 13)).toThrow(RangeError);
    expect(() => presetRange('this_fy', today, 0)).toThrow(RangeError);
  });
  it('matchPreset recognises a preset range, else custom', () => {
    expect(matchPreset({ from: '2026-11-01', to: '2026-11-30' }, today, 3)).toBe('this_month');
    expect(matchPreset({ from: '2026-11-02', to: '2026-11-30' }, today, 3)).toBe('custom');
    expect(matchPreset({ from: null, to: null }, today, 3)).toBe('custom');
  });
});

describe('asAtPresetDate (FY starts March)', () => {
  const today = '2026-11-22';
  it('today, month ends, quarter end and FY end', () => {
    expect(asAtPresetDate('today', today, 3)).toBe(today);
    expect(asAtPresetDate('last_month_end', today, 3)).toBe('2026-10-31');
    expect(asAtPresetDate('this_month_end', today, 3)).toBe('2026-11-30');
    expect(asAtPresetDate('last_quarter_end', today, 3)).toBe('2026-08-31');
    expect(asAtPresetDate('last_fy_end', today, 3)).toBe('2026-02-28');
  });
  it('last FY end across a leap year and a January start', () => {
    expect(asAtPresetDate('last_fy_end', '2028-06-01', 3)).toBe('2028-02-29');
    expect(asAtPresetDate('last_fy_end', today, 1)).toBe('2025-12-31');
  });
  it('custom has no date; keys are unique', () => {
    expect(asAtPresetDate('custom', today, 3)).toBeNull();
    expect(new Set(AS_AT_PRESET_KEYS).size).toBe(AS_AT_PRESET_KEYS.length);
  });
});
