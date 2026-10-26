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
import type { FieldHelpContent } from './FieldHelp';
import { useParsedField, type FieldValidity, type ParseOutcome } from './useParsedField';
import { addDaysISO, localDateFromISO } from '@/lib/dateUtils';
import { assertISODate, parseSaDate, todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate, formatDisplayDateWeekday } from '@/utils/dateFormat';

export interface DateFieldProps {
  label: string;
  /** ISO 'YYYY-MM-DD', or null when empty / not understood. */
  value: string | null;
  /**
   * Fires on blur / Enter when the value or its validity changed. `validity.valid` is false when the text
   * was refused (unreadable, or outside minDate / maxDate): the value is then null but the field is NOT
   * empty, so block submit on it.
   */
  onChange: (iso: string | null, validity: FieldValidity) => void;
  id?: string;
  /** Names a hidden input that posts the canonical ISO date in a native form submit. */
  name?: string;
  /** Inclusive lower bound, ISO. Must be a real 'YYYY-MM-DD' or the field throws a RangeError. */
  minDate?: string;
  /** Inclusive upper bound, ISO. Must be a real 'YYYY-MM-DD' or the field throws a RangeError. */
  maxDate?: string;
  /** Shown when the date is before `minDate` (default names the date). */
  minMessage?: string;
  /** Shown when the date is after `maxDate` (default names the date). */
  maxMessage?: string;
  /**
   * Change it (any value) to put the display back to `value` and drop the refusal on screen. Needed whenever
   * the parent re-asserts a `value` it ALREADY holds: the user typed garbage over a date the parent kept
   * (a filter that ignores refused text) or over null, then the form resets or a "Today" button sets the
   * same date again. A prop that did not change is not news, so only resetKey can say so. A different
   * `value` restores the display by itself. Pinned in DateField.test.tsx ("refused text over a value the parent keeps").
   */
  resetKey?: string | number;
  /** External error (e.g. from the server). Overrides the field's own. */
  error?: string;
  helperText?: string;
  /** (i) tooltip next to the label, with an optional "Learn more" link. */
  help?: FieldHelpContent;
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
    label, value, onChange, id, name, minDate, maxDate, minMessage, maxMessage, error: externalError, helperText, help, resetKey,
    placeholder = 'dd MMM yyyy', required, disabled, getToday, className, onBlur,
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const now = (): Date => (getToday ? getToday() : new Date());
  if (minDate !== undefined) assertISODate(minDate, 'minDate');
  if (maxDate !== undefined) assertISODate(maxDate, 'maxDate');
  const show = (iso: string): string => formatDisplayDate(localDateFromISO(iso), '');

  const check = (iso: string): string | null => {
    if (minDate && iso < minDate) return minMessage ?? `The date must be on or after ${show(minDate)}.`;
    if (maxDate && iso > maxDate) return maxMessage ?? `The date must be on or before ${show(maxDate)}.`;
    return null;
  };

  const parse = (text: string): ParseOutcome<string> => {
    if (text.trim() === '') return required ? { ok: false, reason: 'Enter a date.' } : { ok: true, value: null };
    const r = parseSaDate(text, now());
    if (!r.ok) return { ok: false, reason: r.reason };
    const refusal = check(r.iso);
    return refusal ? { ok: false, reason: refusal } : { ok: true, value: r.iso };
  };

  const field = useParsedField<string>({ value, format: show, parse, onChange, resetKey });
  const error = externalError ?? field.error;
  const understood = field.text.trim() === '' ? null : parseSaDate(field.text, now());
  const echo = understood?.ok ? formatDisplayDateWeekday(localDateFromISO(understood.iso), '') || null : null;
  const frame = { error, helperText, echo, help };

  /** One day up or down from the date on screen (or from today when empty). Unreadable text is left alone. */
  const step = (days: number): boolean => {
    if (field.text.trim() === '') {
      field.commit(show(todayInSast(now())));
      return true;
    }
    if (!understood?.ok) return false;
    field.commit(show(addDaysISO(understood.iso, days)));
    return true;
  };

  return (
    <FieldFrame id={inputId} label={label} required={required} {...frame}>
      <input
        ref={ref}
        id={inputId}
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
          else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step(e.key === 'ArrowUp' ? 1 : -1)) {
            e.preventDefault();
          }
        }}
        className={cn(inputVariants({ inputVariant: error ? 'error' : 'default' }), 'tabular-nums', className)}
      />
      {name && <input type="hidden" name={name} value={value ?? ''} />}
    </FieldFrame>
  );
});
