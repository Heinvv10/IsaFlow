/**
 * DateRangeField — a From/To pair of typed DateFields plus preset pills that follow the company's financial
 * year (this month, last month, this/last quarter, this FY, year to date, last FY, last 30 days, Custom).
 * Typing stays first-class: every preset just fills the two boxes, and editing a box switches to Custom.
 * `To` refuses a date before `From`; moving `From` past `To` pulls `To` along rather than leaving it inverted.
 * A page that already owns its From/To fields and their gating uses FiscalPresetBar instead.
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { DateField } from './DateField';
import { FiscalPresetBar } from './FiscalPresetBar';
import type { FyPresetKey } from '@/lib/fiscalRangePresets';

export interface DateRange { from: string | null; to: string | null }

export interface DateRangeFieldProps {
  /** Names the group for assistive tech, e.g. "Period". */
  label: string;
  value: DateRange;
  onChange: (range: DateRange) => void;
  /** 1-12. Defaults to the active company's financial year start, else March. */
  fyStartMonth?: number;
  presets?: FyPresetKey[];
  fromLabel?: string;
  toLabel?: string;
  /** Test clock; defaults to now. */
  getToday?: () => Date;
  className?: string;
  disabled?: boolean;
  /** An emptied box shows "Enter a date." instead of silently keeping the old range. */
  required?: boolean;
}

export function DateRangeField({
  label, value, onChange, fyStartMonth, presets, fromLabel = 'From', toLabel = 'To', getToday, className, disabled, required,
}: DateRangeFieldProps) {
  // Custom holds for the range the user typed. A range the parent sets on its own (a reset, a deep link) is a
  // different key, so Custom lets go.
  const [customFor, setCustomFor] = React.useState<string | null>(null);
  const rangeKey = (r: DateRange) => `${r.from}|${r.to}`;
  const custom = customFor === rangeKey(value);
  const emit = (r: DateRange) => { setCustomFor(rangeKey(r)); onChange(r); };
  const setFrom = (from: string | null) => emit({ from, to: from && value.to && value.to < from ? from : value.to });
  const setTo = (to: string | null) => emit({ from: value.from, to });

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <FiscalPresetBar label={label} value={value} custom={custom} fyStartMonth={fyStartMonth} presets={presets}
        getToday={getToday} disabled={disabled} onCustom={() => setCustomFor(rangeKey(value))}
        onPick={r => { setCustomFor(null); onChange({ from: r.from, to: r.to }); }} />
      <div className="flex flex-wrap items-end gap-4">
        <DateField label={fromLabel} value={value.from} disabled={disabled} required={required} getToday={getToday}
          onChange={(iso, v) => { if (v.valid) setFrom(iso); }} />
        <DateField label={toLabel} value={value.to} disabled={disabled} required={required} getToday={getToday}
          minDate={value.from ?? undefined} minMessage={`${toLabel} can't be before ${fromLabel}`}
          anchorDate={value.from}
          onChange={(iso, v) => { if (v.valid) setTo(iso); }} />
      </div>
    </div>
  );
}
