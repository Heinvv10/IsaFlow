/**
 * Invoice-date period control: all dates, one month, or a custom from/to.
 * Emits an inclusive from/to pair; a month is only a way of picking one.
 */

import { useEffect, useState } from 'react';
import { localDateFromISO } from '@/lib/dateUtils';
import { currentMonth, monthRange, wholeMonthOf } from './invoicePeriod';
import { DateField } from '@/components/ui/DateField';

type Mode = 'all' | 'month' | 'custom';

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  inputClassName: string;
}

/** A bound DateField can take: the URL can hold anything, and DateField throws on a non-ISO bound. */
function boundOrUndefined(iso: string): string | undefined {
  return iso && localDateFromISO(iso) !== null ? iso : undefined;
}

function modeOf(from: string, to: string): Mode {
  if (!from && !to) return 'all';
  return wholeMonthOf(from, to) ? 'month' : 'custom';
}

export function PeriodControl({ from, to, onChange, inputClassName }: Props) {
  const [mode, setMode] = useState<Mode>(() => modeOf(from, to));

  // Follow the URL (deep link, back/forward, clear all), but keep a custom
  // range custom even when it happens to cover exactly one month.
  useEffect(() => {
    setMode(m => (m === 'custom' && (from || to) ? 'custom' : modeOf(from, to)));
  }, [from, to]);

  function pickMode(next: Mode) {
    setMode(next);
    if (next === 'all') onChange('', '');
    if (next === 'month') {
      const r = monthRange(currentMonth());
      if (r) onChange(r.from, r.to);
    }
  }

  const month = wholeMonthOf(from, to) ?? '';

  return (
    <div className="flex items-center gap-2">
      <select
        name="period"
        aria-label="Invoice date period"
        value={mode}
        onChange={e => pickMode(e.target.value as Mode)}
        className={inputClassName}
      >
        <option value="all">All dates</option>
        <option value="month">Month</option>
        <option value="custom">Custom range</option>
      </select>
      {mode === 'month' && (
        <input
          type="month"
          name="month"
          aria-label="Invoice month"
          value={month}
          onChange={e => {
            const r = monthRange(e.target.value);
            if (r) onChange(r.from, r.to);
          }}
          className={inputClassName}
        />
      )}
      {mode === 'custom' && (
        <>
          <div className="w-40">
            <DateField label="Invoice date from" name="from" value={from || null} maxDate={boundOrUndefined(to)}
              onChange={(iso, v) => { if (v.valid) onChange(iso ?? '', to); }} />
          </div>
          <div className="w-40">
            <DateField label="Invoice date to" name="to" value={to || null} minDate={boundOrUndefined(from)}
              onChange={(iso, v) => { if (v.valid) onChange(from, iso ?? ''); }} />
          </div>
        </>
      )}
    </div>
  );
}
