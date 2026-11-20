/**
 * AmountInput - a plain money/quantity text box that keeps what the person typed while they type.
 * The old `<input type="number" value={n || ''} onChange={Number(e.target.value)}>` pattern parsed on every keystroke
 * and wrote the number back, so "0." became 0 and a field that started at 0 kept the 0 in front of whatever was typed.
 * Here the text is local; the parent gets the number on every change; focus (and the mouseup that follows a click)
 * selects a zero so the first keystroke replaces it.
 * Text is normalised on every change: "R", spaces and thousands separators go, a lone comma is a decimal ("1 234,56" is
 * 1234.56). Anything that is still not digits with at most `decimals` decimals is refused and the field says so
 * (aria-invalid + a validity message) until the next accepted change. A lone "." is not an amount: the browser's form
 * check (setCustomValidity) refuses it, as it does an empty `required` field and a value outside `min` / `max`.
 * `value` is a string (the parent keeps text) or a number (0 shows empty, with the placeholder).
 */
import * as React from 'react';
import { normaliseAmountText, amountValidity } from './amountInputText';

const asText = (v: string | number): string => (typeof v === 'number' ? (v === 0 ? '' : String(v)) : v);
const isZeroText = (t: string): boolean => t.trim() !== '' && /^0*\.?0*$/.test(t.trim());
const patterns = new Map<number, RegExp>();
const amountPattern = (decimals: number): RegExp => {
  let re = patterns.get(decimals);
  if (!re) { re = new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`); patterns.set(decimals, re); }
  return re;
};
const REFUSED = 'Enter an amount like 100 or 100.50.';

export interface AmountInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> {
  value: string | number;
  /** The typed text and its number (0 while the text is empty or just "."). */
  onValueChange: (num: number, text: string) => void;
  min?: number;
  max?: number;
  /** Most decimals accepted (default 2: cents). */
  decimals?: number;
}

export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(function AmountInput(
  { value, onValueChange, onFocus, onBlur, onMouseUp, min, max, decimals = 2, required, ...rest }, ref,
) {
  const inner = React.useRef<HTMLInputElement | null>(null);
  const justFocused = React.useRef(false);
  const [draft, setDraft] = React.useState(asText(value));
  const [refused, setRefused] = React.useState(false);
  const setRefs = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) ref.current = el;
  };
  const emitted = React.useRef(Number(asText(value)) || 0);
  // Set when onChange hands the parent a value; the next value change is then its echo. Only an echo may keep a draft
  // the parent states differently ("0.75" -> 0.75, a typed 0 -> '' under `n || ''`); any other change (a reset after a
  // save, "fill remaining") finds no pending echo and is adopted, '' included.
  const pendingEcho = React.useRef(false);
  React.useEffect(() => {
    const echo = pendingEcho.current;
    pendingEcho.current = false;
    setRefused(false);
    if (typeof value === 'string') {
      emitted.current = Number(value) || 0; // so the same number coming back from the parent later is shown again
      setDraft(prev => (prev === value || (echo && (Number(prev) || 0) === (Number(value) || 0)) ? prev : value));
      return;
    }
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(asText(value));
  }, [value]);
  const message = refused ? REFUSED : amountValidity(draft, { min, max, required: Boolean(required) });
  React.useEffect(() => { inner.current?.setCustomValidity(message); }, [message]);
  return (
    <input
      {...rest}
      ref={setRefs}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      required={required}
      data-amount-input=""
      aria-invalid={message ? true : undefined}
      value={draft}
      onFocus={e => {
        if (isZeroText(e.currentTarget.value)) { justFocused.current = true; e.currentTarget.select(); }
        onFocus?.(e);
      }}
      // A refusal outlives blur: clicking Submit blurs first, and the refused text must still block that submit.
      onBlur={e => { justFocused.current = false; onBlur?.(e); }}
      onMouseUp={e => {
        // The mouseup of the click that focused the field would drop the selection and park the caret after the 0.
        if (justFocused.current) { e.preventDefault(); justFocused.current = false; }
        onMouseUp?.(e);
      }}
      onChange={e => {
        const text = normaliseAmountText(e.target.value, decimals);
        if (!amountPattern(decimals).test(text)) { setRefused(true); return; }
        setRefused(false);
        setDraft(text);
        emitted.current = Number(text) || 0;
        pendingEcho.current = true;
        onValueChange(emitted.current, text);
      }}
    />
  );
});
