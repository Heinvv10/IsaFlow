/**
 * MoneyField — labelled amount input. Parses South African money text ONCE, on blur or Enter,
 * hands the parent integer cents (or null), and echoes what it understood ("R 25 000.00").
 * Input it cannot read unambiguously ("1,234") is refused with a reason, never guessed.
 * Pairs with <Money> for read-only display.
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { inputVariants } from './Input';
import { FieldFrame, describedBy } from './FieldFrame';
import type { FieldHelpContent } from './FieldHelp';
import { useParsedField, type FieldValidity, type ParseOutcome } from './useParsedField';
import { formatCents } from '@/lib/money/formatMoney';
import { parseSaAmount } from '@/lib/money/saAmountParser';

export interface MoneyFieldProps {
  label: string;
  /** Integer cents, or null when empty / not understood. */
  value: number | null;
  /**
   * Fires on blur / Enter when the value or its validity changed. `validity.valid` is false when the text
   * was refused: the value is then null but the field is NOT empty, so block submit on it.
   */
  onChange: (cents: number | null, validity: FieldValidity) => void;
  id?: string;
  /** Names a hidden input that posts the canonical value (integer cents) in a native form submit. */
  name?: string;
  /** Shown as a badge; the echo is "R ..." for ZAR and "<code> ..." otherwise. */
  currency?: string;
  /** Change it to discard refused text on screen (a form reset); `value` alone cannot, null stays null. */
  resetKey?: string | number;
  /** External error (e.g. from the server). Overrides the field's own. */
  error?: string;
  helperText?: string;
  /** (i) tooltip next to the label, with an optional "Learn more" link. */
  help?: FieldHelpContent;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Default false: a negative amount is refused with a reason. */
  allowNegative?: boolean;
  /** Inclusive bounds in cents. */
  min?: number;
  max?: number;
  className?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
}

export const MoneyField = React.forwardRef<HTMLInputElement, MoneyFieldProps>(function MoneyField(
  {
    label, value, onChange, id, name, currency = 'ZAR', error: externalError, helperText, help, resetKey, placeholder = '0.00',
    required, disabled, allowNegative = false, min, max, className, onBlur,
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const echoOf = (cents: number): string =>
    currency === 'ZAR' ? formatCents(cents) : `${currency} ${formatCents(cents, { symbol: false })}`;

  const parse = (text: string): ParseOutcome<number> => {
    if (text.trim() === '') return required ? { ok: false, reason: 'Enter an amount.' } : { ok: true, value: null };
    const r = parseSaAmount(text, { currency });
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.cents < 0 && !allowNegative) return { ok: false, reason: 'A negative amount is not allowed here.' };
    if (min !== undefined && r.cents < min) return { ok: false, reason: `The amount must be at least ${echoOf(min)}.` };
    if (max !== undefined && r.cents > max) return { ok: false, reason: `The amount must be at most ${echoOf(max)}.` };
    return { ok: true, value: r.cents };
  };

  const field = useParsedField<number>({
    value, format: (cents) => formatCents(cents, { symbol: false }), parse, onChange, resetKey,
  });
  const error = externalError ?? field.error;
  const understood = field.text.trim() === '' ? null : parseSaAmount(field.text, { currency });
  const echo = understood?.ok && (allowNegative || understood.cents >= 0) ? echoOf(understood.cents) : null;
  const frame = { error, helperText, echo, help };

  return (
    <FieldFrame id={inputId} label={label} required={required} {...frame}>
      <div className="relative flex items-center">
        <span
          className="pointer-events-none absolute left-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold tracking-wide text-gray-700 dark:bg-gray-700 dark:text-gray-200"
        >
          {currency}
        </span>
        <input
          ref={ref}
          id={inputId}
          type="text"
          inputMode="decimal"
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
          }}
          className={cn(
            inputVariants({ inputVariant: error ? 'error' : 'default' }),
            'pl-14 text-right tabular-nums',
            className,
          )}
        />
        {name && <input type="hidden" name={name} value={value === null ? '' : String(value)} />}
      </div>
    </FieldFrame>
  );
});
