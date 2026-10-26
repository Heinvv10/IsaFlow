/**
 * PeriodPicker — shared date-range / as-of picker with preset pills.
 * mode='range' → emits { dateFrom, dateTo }
 * mode='asof'  → emits { asOfDate }
 */
import { useState } from 'react';
import { localISODate, monthEndISO, monthStartISO, prevMonthRange } from '@/lib/dateUtils';
import { DateField } from '@/components/ui/DateField';

export type PeriodPreset = 'this_month' | 'last_month' | 'this_quarter' | 'ytd' | 'last_year' | 'custom';
export type AsofPreset = 'today' | 'month_end' | 'quarter_end' | 'custom';
export interface PeriodRange { dateFrom: string; dateTo: string; }
export interface PeriodPickerProps {
  mode?: 'range' | 'asof';
  value: PeriodRange | { asOfDate: string };
  onChange: (value: PeriodRange | { asOfDate: string }) => void;
  labelRange?: { from?: string; to?: string };
  labelAsOf?: string;
}

// ---------- local-calendar date helpers ----------
function iso(d: Date) { return localISODate(d); }
function today() { return iso(new Date()); }
function fom(d: Date) { return monthStartISO(d); }
function lom(d: Date) { return monthEndISO(d); }
function foq(d: Date) { return iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)); }
function loq(d: Date) { return iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 0)); }
function foy(d: Date) { return iso(new Date(d.getFullYear(), 0, 1)); }
function lastMonthRange(now: Date): PeriodRange {
  const { start, end } = prevMonthRange(now);
  return { dateFrom: start, dateTo: end };
}
function lastYearRange(now: Date): PeriodRange { const y = now.getFullYear() - 1; return { dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` }; }

export function resolveRange(preset: PeriodPreset): PeriodRange | null {
  const n = new Date();
  switch (preset) {
    case 'this_month':   return { dateFrom: fom(n), dateTo: today() };
    case 'last_month':   return lastMonthRange(n);
    case 'this_quarter': return { dateFrom: foq(n), dateTo: today() };
    case 'ytd':          return { dateFrom: foy(n), dateTo: today() };
    case 'last_year':    return lastYearRange(n);
    case 'custom':       return null;
  }
}

export function resolveAsof(preset: AsofPreset): string | null {
  const n = new Date();
  switch (preset) {
    case 'today':        return today();
    case 'month_end':    return lom(n);
    case 'quarter_end':  return loq(n);
    case 'custom':       return null;
  }
}

// ---------- styles ----------
const PILL = 'px-3 py-1 rounded-full text-xs border transition-colors cursor-pointer';
const ACTIVE = 'bg-slate-900 text-white border-slate-700';
const IDLE = 'bg-transparent text-[var(--ff-text-secondary)] border-[var(--ff-border-primary)] hover:border-slate-500';

const RANGE_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' },
  { key: 'this_quarter', label: 'This quarter' }, { key: 'ytd', label: 'YTD' },
  { key: 'last_year', label: 'Last year' }, { key: 'custom', label: 'Custom' },
];

const ASOF_PRESETS: { key: AsofPreset; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'month_end', label: 'Month end' },
  { key: 'quarter_end', label: 'Quarter end' }, { key: 'custom', label: 'Custom' },
];

// ---------- component ----------
export function PeriodPicker({ mode = 'range', value, onChange, labelRange, labelAsOf }: PeriodPickerProps) {
  const [preset, setPreset] = useState<PeriodPreset | AsofPreset>('this_month');

  if (mode === 'range') {
    const rv = value as PeriodRange;
    const pickRange = (k: PeriodPreset) => { setPreset(k); const r = resolveRange(k); if (r) onChange(r); };
    const setFrom = (v: string) => { setPreset('custom'); onChange({ dateFrom: v, dateTo: rv.dateTo }); };
    const setTo = (v: string) => { setPreset('custom'); onChange({ dateFrom: rv.dateFrom, dateTo: v }); };
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map(({ key, label }) => (
            <button key={key} type="button" onClick={() => pickRange(key)} className={`${PILL} ${preset === key ? ACTIVE : IDLE}`}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 items-end">
          <DateField label={labelRange?.from ?? 'From'} required value={rv.dateFrom || null}
            onChange={(iso, v) => { if (v.valid && iso) setFrom(iso); }} />
          <DateField label={labelRange?.to ?? 'To'} required value={rv.dateTo || null}
            onChange={(iso, v) => { if (v.valid && iso) setTo(iso); }} />
        </div>
      </div>
    );
  }

  // asof mode
  const av = value as { asOfDate: string };
  function pickAsof(k: AsofPreset) { setPreset(k); const r = resolveAsof(k); if (r) onChange({ asOfDate: r }); }
  function setAsof(v: string) { setPreset('custom'); onChange({ asOfDate: v }); }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {ASOF_PRESETS.map(({ key, label }) => (
          <button key={key} type="button" onClick={() => pickAsof(key)} className={`${PILL} ${preset === key ? ACTIVE : IDLE}`}>{label}</button>
        ))}
      </div>
      <DateField label={labelAsOf ?? 'As of'} required value={av.asOfDate || null}
        onChange={(iso, v) => { if (v.valid && iso) setAsof(iso); }} />
    </div>
  );
}
