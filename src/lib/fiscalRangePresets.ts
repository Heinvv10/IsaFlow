/**
 * Report-range presets that follow the company's financial year (not the calendar year).
 * Pure ISO-string arithmetic, so no timezone can move a date. `fyStartMonth` is 1-12.
 */
export type FyPresetKey =
  | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter'
  | 'this_fy' | 'fy_to_date' | 'last_fy' | 'last_30_days' | 'custom';

export const FY_PRESET_KEYS: FyPresetKey[] = [
  'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'fy_to_date', 'last_fy', 'last_30_days', 'custom',
];

/** For a page that owns its From/To boxes: typing there is Custom, so the bar needs no Custom pill. */
export const FY_PRESETS_FIXED: FyPresetKey[] = FY_PRESET_KEYS.filter(k => k !== 'custom');

export const FY_PRESET_LABELS: Record<FyPresetKey, string> = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', last_quarter: 'Last quarter',
  this_fy: 'This financial year', fy_to_date: 'Year to date', last_fy: 'Last financial year',
  last_30_days: 'Last 30 days', custom: 'Custom',
};

/** Used when a company has no financial-year start month set (the books' historical default). */
export const DEFAULT_FY_START_MONTH = 3;

export interface IsoRange { from: string; to: string }

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Months are counted from year 0 (year * 12 + month - 1), so shifting is plain arithmetic. */
function split(idx: number): { y: number; m: number } { return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }; }
function monthRange(startIdx: number, months: number): IsoRange {
  const a = split(startIdx); const b = split(startIdx + months - 1);
  return { from: iso(a.y, a.m, 1), to: iso(b.y, b.m, lastDay(b.y, b.m)) };
}

function addDays(isoDate: string, days: number): string {
  const [y = 0, m = 1, d = 1] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function presetRange(key: FyPresetKey, today: string, fyStartMonth: number): IsoRange | null {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) {
    throw new RangeError(`Financial year start month must be 1-12, got ${fyStartMonth}`);
  }
  const [y = 0, m = 1] = today.split('-').map(Number);
  const nowIdx = y * 12 + (m - 1);
  const fyIdx = (m >= fyStartMonth ? y : y - 1) * 12 + (fyStartMonth - 1);
  const qStart = fyIdx + Math.floor((nowIdx - fyIdx) / 3) * 3;
  switch (key) {
    case 'this_month': return monthRange(nowIdx, 1);
    case 'last_month': return monthRange(nowIdx - 1, 1);
    case 'this_quarter': return monthRange(qStart, 3);
    case 'last_quarter': return monthRange(qStart - 3, 3);
    case 'this_fy': return monthRange(fyIdx, 12);
    case 'fy_to_date': return { from: monthRange(fyIdx, 12).from, to: today };
    case 'last_fy': return monthRange(fyIdx - 12, 12);
    case 'last_30_days': return { from: addDays(today, -29), to: today };
    case 'custom': return null;
  }
}

export function fiscalRangePresets(today: string, fyStartMonth: number): { key: FyPresetKey; label: string; range: IsoRange }[] {
  return FY_PRESET_KEYS.filter(k => k !== 'custom').map(key => ({
    key, label: FY_PRESET_LABELS[key], range: presetRange(key, today, fyStartMonth) as IsoRange,
  }));
}

/** Which preset the current range equals, or 'custom'. */
export function matchPreset(value: { from: string | null; to: string | null }, today: string, fyStartMonth: number): FyPresetKey {
  if (!value.from || !value.to) return 'custom';
  const hit = fiscalRangePresets(today, fyStartMonth).find(p => p.range.from === value.from && p.range.to === value.to);
  return hit ? hit.key : 'custom';
}

export type AsAtPresetKey = 'today' | 'last_month_end' | 'this_month_end' | 'last_quarter_end' | 'last_fy_end' | 'custom';
export const AS_AT_PRESET_KEYS: AsAtPresetKey[] = ['today', 'last_month_end', 'this_month_end', 'last_quarter_end', 'last_fy_end', 'custom'];
export const AS_AT_PRESET_LABELS: Record<AsAtPresetKey, string> = {
  today: 'Today', last_month_end: 'Last month end', this_month_end: 'This month end',
  last_quarter_end: 'Last quarter end', last_fy_end: 'Last year end', custom: 'Custom',
};

/** The single date an as-at report takes for a preset, or null for Custom. */
export function asAtPresetDate(key: AsAtPresetKey, today: string, fyStartMonth: number): string | null {
  switch (key) {
    case 'today': return today;
    case 'last_month_end': return presetRange('last_month', today, fyStartMonth)?.to ?? null;
    case 'this_month_end': return presetRange('this_month', today, fyStartMonth)?.to ?? null;
    case 'last_quarter_end': return presetRange('last_quarter', today, fyStartMonth)?.to ?? null;
    case 'last_fy_end': return presetRange('last_fy', today, fyStartMonth)?.to ?? null;
    case 'custom': return null;
  }
}

export const AS_AT_PRESETS_FIXED: AsAtPresetKey[] = AS_AT_PRESET_KEYS.filter(k => k !== 'custom');
