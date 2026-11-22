/**
 * MonthField — labelled month input that is typed, not picked. Shows "Mar 2026", hands the parent 'YYYY-MM' (or null).
 * Typed: "3/2026", "03-2026", "2026-03", "mar 2026", "maart", "mar 26", a bare "3" (that month of this year), `t` this
 * month, `+1` / `-1` months from this one. ArrowUp / ArrowDown move one month. A calendar-style picker (MonthPopup)
 * opens only from the button or Alt+ArrowDown, never on focus. `minMonth` / `maxMonth` ('YYYY-MM', inclusive) refuse a
 * month outside them. A refusal reports `validity.code` ('empty' | 'unreadable' | 'before-min' | 'after-max'): map on the
 * code, not the message. Replaces every native `<input type="month">` (a census test keeps new ones out).
 */
import * as React from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/utils/cn';
import { inputVariants } from './Input';
import { FieldFrame, describedBy } from './FieldFrame';
import type { FieldHelpContent } from './FieldHelp';
import { useParsedField, type FieldValidity, type ParseOutcome } from './useParsedField';
import { MonthPopup } from './MonthPopup';
import { addMonths, clampMonth, formatMonth, parseMonth } from '@/lib/monthParser';
import { todayInSast } from '@/lib/saDateParser';

export type MonthFieldCode = 'empty' | 'unreadable' | 'before-min' | 'after-max';

export interface MonthFieldProps {
  label: string;
  /** 'YYYY-MM', or null when empty / not understood. */
  value: string | null;
  /** Fires on blur / Enter when the value or its validity changed (same contract as DateField). */
  onChange: (ym: string | null, validity: FieldValidity<MonthFieldCode>) => void;
  id?: string;
  /** Names a hidden input that posts 'YYYY-MM' in a native form submit. */
  name?: string;
  minMonth?: string;
  maxMonth?: string;
  /** Change it (any value) to put the display back to `value` and drop a refusal on screen. */
  resetKey?: string | number;
  error?: string;
  helperText?: string;
  help?: FieldHelpContent;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** What "today" is; defaults to the local clock. Injected by tests. */
  getToday?: () => Date;
  className?: string;
  /** Hide the label visually (the field still has it for assistive tech). */
  labelHidden?: boolean;
  /** Mark the box invalid for a problem the PAGE shows (e.g. a From after a To), and point at its element. */
  invalid?: boolean;
  describedById?: string;
  'data-testid'?: string;
}

export const MonthField = React.forwardRef<HTMLInputElement, MonthFieldProps>(function MonthField(
  {
    label, value, onChange, id, name, minMonth, maxMonth, resetKey, error: externalError, helperText, help,
    placeholder = 'Mar 2026', required, disabled, getToday, className, labelHidden, invalid, describedById, 'data-testid': testId,
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const now = (): Date => (getToday ? getToday() : new Date());

  const parse = (text: string): ParseOutcome<string, MonthFieldCode> => {
    if (text.trim() === '') return required ? { ok: false, code: 'empty', reason: 'Enter a month.' } : { ok: true, value: null };
    const r = parseMonth(text, now());
    if (!r.ok) return { ok: false, code: 'unreadable', reason: r.reason };
    if (minMonth && r.ym < minMonth) return { ok: false, code: 'before-min', reason: `The month must be ${formatMonth(minMonth)} or later.` };
    if (maxMonth && r.ym > maxMonth) return { ok: false, code: 'after-max', reason: `The month must be ${formatMonth(maxMonth)} or earlier.` };
    return { ok: true, value: r.ym };
  };

  const field = useParsedField<string, MonthFieldCode>({ value, format: formatMonth, parse, onChange, resetKey });
  const error = externalError ?? field.error;
  const understood = field.text.trim() === '' ? null : parseMonth(field.text, now());
  const frame = { error, helperText, echo: null, help };
  const thisMonth = todayInSast(now()).slice(0, 7);

  const [open, setOpen] = React.useState(false);
  const [wrapEl, setWrapEl] = React.useState<HTMLDivElement | null>(null);
  const [buttonEl, setButtonEl] = React.useState<HTMLButtonElement | null>(null);
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const refocus = React.useRef<'input' | 'button' | null>(null);
  const openedFrom = React.useRef<'input' | 'button'>('button');
  const setRefs = (el: HTMLInputElement | null): void => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  React.useEffect(() => {
    if (!open && refocus.current) {
      (refocus.current === 'input' ? innerRef.current : buttonEl)?.focus();
      refocus.current = null;
    }
  }, [open, buttonEl]);

  /** One month up or down from the month on screen (or from this month when empty). Unreadable text is left alone. */
  const step = (months: number): boolean => {
    if (field.text.trim() === '') { field.commit(formatMonth(clampMonth(thisMonth, minMonth, maxMonth))); return true; }
    if (!understood?.ok) return false;
    field.commit(formatMonth(clampMonth(addMonths(understood.ym, months), minMonth, maxMonth)));
    return true;
  };

  return (
    <FieldFrame id={inputId} label={label} required={required} labelHidden={labelHidden} {...frame}>
      <div ref={setWrapEl} className="relative">
        <input
          ref={setRefs}
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={field.text}
          placeholder={placeholder}
          disabled={disabled}
          data-testid={testId}
          aria-required={required || undefined}
          aria-invalid={Boolean(error) || Boolean(invalid)}
          aria-describedby={[describedBy(inputId, frame), describedById].filter(Boolean).join(' ') || undefined}
          onChange={(e) => field.onTextChange(e.target.value)}
          onBlur={() => field.commit()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && e.altKey) {
              e.preventDefault();
              if (!disabled) { openedFrom.current = 'input'; setOpen(true); }
            } else if (e.key === 'Enter') field.commit();
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step(e.key === 'ArrowUp' ? 1 : -1)) e.preventDefault();
          }}
          className={cn(inputVariants({ inputVariant: error || invalid ? 'error' : 'default' }), 'tabular-nums max-lg:min-h-11 pr-10', className)}
        />
        <button
          ref={setButtonEl}
          type="button"
          aria-label="Choose month"
          title="Choose month (Alt+↓)"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { openedFrom.current = 'button'; setOpen((o) => !o); }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-gray-600 ff-focus-ring hover:text-teal-700 disabled:opacity-40 max-lg:w-11 dark:text-gray-400 dark:hover:text-teal-300"
        >
          <CalendarDays size={16} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <MonthPopup
          anchor={wrapEl}
          trigger={buttonEl}
          selected={understood?.ok ? understood.ym : value}
          start={understood?.ok ? understood.ym : (value ?? thisMonth)}
          today={thisMonth}
          minMonth={minMonth}
          maxMonth={maxMonth}
          onPick={(ym) => { refocus.current = 'input'; field.commit(formatMonth(ym)); setOpen(false); }}
          onClose={(restoreFocus) => { if (restoreFocus) refocus.current = openedFrom.current; setOpen(false); }}
        />
      )}
      {name && <input type="hidden" name={name} value={value ?? ''} />}
    </FieldFrame>
  );
});
