/**
 * PeriodPicker — shared date-range / as-of picker with preset pills.
 * mode='range' → emits { dateFrom, dateTo } (DateRangeField: presets follow the company financial year)
 * mode='asof'  → emits { asOfDate }
 */
import { useState } from 'react';
import { localISODate, monthEndISO } from '@/lib/dateUtils';
import { DateField } from '@/components/ui/DateField';
import { DateRangeField } from '@/components/ui/DateRangeField';

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
function lom(d: Date) { return monthEndISO(d); }
function loq(d: Date) { return iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 0)); }

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

const ASOF_PRESETS: { key: AsofPreset; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'month_end', label: 'Month end' },
  { key: 'quarter_end', label: 'Quarter end' }, { key: 'custom', label: 'Custom' },
];

// ---------- component ----------
export function PeriodPicker({ mode = 'range', value, onChange, labelRange, labelAsOf }: PeriodPickerProps) {
  const [preset, setPreset] = useState<AsofPreset | null>(null);

  if (mode === 'range') {
    const rv = value as PeriodRange;
    return (
      <DateRangeField label="Period" fromLabel={labelRange?.from ?? 'From'} toLabel={labelRange?.to ?? 'To'}
        value={{ from: rv.dateFrom || null, to: rv.dateTo || null }}
        onChange={r => { if (r.from && r.to) onChange({ dateFrom: r.from, dateTo: r.to }); }} />
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
