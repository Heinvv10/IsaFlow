/**
 * DateField — labelled date input that is typed, not picked. Shows "01 Oct 2026", hands the
 * parent ISO "2026-10-01" (or null), and echoes what it understood ("Thursday, 1 October 2026").
 *
 * Typed shortcuts: `t` today, `+30` / `-7` days from today, `eom` end of month; also "1 Oct 2026",
 * "2026-10-01" and "01/10/2026" (day first). ArrowUp / ArrowDown move the date by one day.
 * `minDate` / `maxDate` (inclusive ISO, e.g. the financial year or a lock date) refuse a date
 * outside them with a message, and the parent receives null rather than a date it must not post.
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { inputVariants } from './Input';
import { FieldFrame, describedBy } from './FieldFrame';
import { useParsedField, type ParseOutcome } from './useParsedField';
import { addDaysISO, localISODate } from '@/lib/dateUtils';
import { formatSaDate, formatSaDateLong, parseSaDate } from '@/lib/saDateParser';

export interface DateFieldProps {
  label: string;
  /** ISO 'YYYY-MM-DD', or null when empty / not understood. */
  value: string | null;
  onChange: (iso: string | null) => void;
  id?: string;
  name?: string;
  /** Inclusive lower bound, ISO. */
  minDate?: string;
  /** Inclusive upper bound, ISO. */
  maxDate?: string;
  /** Shown when the date is before `minDate` (default names the date). */
  minMessage?: string;
  /** Shown when the date is after `maxDate` (default names the date). */
  maxMessage?: string;
  /** External error (e.g. from the server). Overrides the field's own. */
  error?: string;
  helperText?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** What "today" is; defaults to the local clock. Injected by tests. */
  getToday?: () => Date;
  className?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
}

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  {
    label, value, onChange, id, name, minDate, maxDate, minMessage, maxMessage, error: externalError, helperText,
    placeholder = 'dd MMM yyyy', required, disabled, getToday, className, onBlur,
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const now = (): Date => (getToday ? getToday() : new Date());

  const check = (iso: string): string | null => {
    if (minDate && iso < minDate) return minMessage ?? `The date must be on or after ${formatSaDate(minDate)}.`;
    if (maxDate && iso > maxDate) return maxMessage ?? `The date must be on or before ${formatSaDate(maxDate)}.`;
    return null;
  };

  const parse = (text: string): ParseOutcome<string> => {
    if (text.trim() === '') return required ? { ok: false, reason: 'Enter a date.' } : { ok: true, value: null };
    const r = parseSaDate(text, now());
    if (!r.ok) return { ok: false, reason: r.reason };
    const refusal = check(r.iso);
    return refusal ? { ok: false, reason: refusal } : { ok: true, value: r.iso };
  };

  const field = useParsedField<string>({ value, format: formatSaDate, parse, onChange });
  const error = externalError ?? field.error;
  const understood = field.text.trim() === '' ? null : parseSaDate(field.text, now());
  const echo = understood?.ok ? formatSaDateLong(understood.iso) : null;
  const frame = { error, helperText, echo };

  const step = (days: number): void => {
    const base = understood?.ok ? understood.iso : localISODate(now());
    field.commit(formatSaDate(addDaysISO(base, understood?.ok ? days : 0)));
  };

  return (
    <FieldFrame id={inputId} label={label} required={required} {...frame}>
      <input
        ref={ref}
        id={inputId}
        name={name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={field.text}
        placeholder={placeholder}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(inputId, frame)}
        onChange={(e) => field.onTextChange(e.target.value)}
        onBlur={(e) => {
          field.commit();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') field.commit();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.key === 'ArrowUp' ? 1 : -1);
          }
        }}
        className={cn(inputVariants({ inputVariant: error ? 'error' : 'default' }), 'tabular-nums', className)}
      />
    </FieldFrame>
  );
});
