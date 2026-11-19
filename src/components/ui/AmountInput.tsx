/**
 * AmountInput - a plain money/quantity text box that keeps what the person typed while they type.
 * The old `<input type="number" value={n || ''} onChange={Number(e.target.value)}>` pattern parsed on every keystroke
 * and wrote the number back, so "0." became 0 and was shown as "" or "0" again, and a field that started at 0 kept the
 * 0 in front of whatever was typed. Here the text is local; the parent gets the number on every change; focus selects a
 * zero so the first keystroke replaces it. Non-numeric keystrokes are refused.
 * `min` / `max` keep the native form check: a text box has none, so they set the field's custom validity (submit is
 * refused with the message; an empty optional field is not checked).
 * `value` is a string (the parent keeps text) or a number (0 shows empty, with the placeholder).
 */
import * as React from 'react';

const PARTIAL_AMOUNT_RE = /^\d*(\.\d*)?$/;
const asText = (v: string | number): string => (typeof v === 'number' ? (v === 0 ? '' : String(v)) : v);
const isZeroText = (t: string): boolean => t.trim() !== '' && /^0*\.?0*$/.test(t.trim());

export interface AmountInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> {
  value: string | number;
  min?: number;
  max?: number;
  /** The typed text and its number (0 while the text is empty or just "."). */
  onValueChange: (num: number, text: string) => void;
}

export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(function AmountInput(
  { value, onValueChange, onFocus, min, max, ...rest }, ref,
) {
  const inner = React.useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) ref.current = el;
  };
  const [draft, setDraft] = React.useState(asText(value));
  // The parent changed the value to something the draft does not already say (a reset, a "fill remaining"): follow it.
  React.useEffect(() => {
    setDraft(prev => ((Number(prev) || 0) === (Number(asText(value)) || 0) ? prev : asText(value)));
  }, [value]);
  React.useEffect(() => {
    const n = Number(draft);
    let msg = '';
    if (draft !== '') {
      if (min !== undefined && n < min) msg = `The amount must be at least ${min}.`;
      else if (max !== undefined && n > max) msg = `The amount cannot be more than ${max}.`;
    }
    inner.current?.setCustomValidity(msg);
  }, [draft, min, max]);
  return (
    <input
      {...rest}
      ref={setRefs}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={draft}
      onFocus={e => { if (isZeroText(e.currentTarget.value)) e.currentTarget.select(); onFocus?.(e); }}
      onChange={e => {
        const text = e.target.value;
        if (!PARTIAL_AMOUNT_RE.test(text)) return;
        setDraft(text);
        onValueChange(Number(text) || 0, text);
      }}
    />
  );
});
