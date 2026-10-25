/**
 * useParsedField — text-in, typed-value-out state shared by MoneyField and DateField.
 *
 * The user types free text; it is parsed ONCE on commit (blur / Enter). The parent only ever sees the
 * parsed value (or null), never a half-typed string. `null` alone cannot tell "left empty" from "typed
 * something we refused", so every report carries a validity: `{ valid: false, reason }` means the text is
 * on screen but was refused, and a form must not submit. onChange fires when the value OR the validity
 * changes (typing "abc" into an empty field is still news). An outside change to `value` replaces the
 * text; the echo of our own commit does not. A parent that resets the form while refused text is on screen
 * cannot do it with `value` alone (it was null before and is null after), so it changes `resetKey`: the text,
 * the error and the reported validity are cleared and the field follows `value` again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ParseOutcome<T> = { ok: true; value: T | null } | { ok: false; reason: string };

export interface FieldValidity {
  valid: boolean;
  /** Why the text was refused; null when valid. */
  reason: string | null;
}

const VALID: FieldValidity = { valid: true, reason: null };

interface Options<T> {
  value: T | null;
  format: (value: T) => string;
  parse: (text: string) => ParseOutcome<T>;
  onChange: (value: T | null, validity: FieldValidity) => void;
  /** Change it (any value, any change) to discard what is on screen, e.g. a form reset. */
  resetKey?: string | number;
}

export interface ParsedField {
  text: string;
  /** Reason the last commit was refused; cleared as soon as the user types again. */
  error: string | null;
  onTextChange: (text: string) => void;
  /** Parse `override ?? text` now and report the result to the parent. */
  commit: (override?: string) => void;
}

export function useParsedField<T>({ value, format, parse, onChange, resetKey }: Options<T>): ParsedField {
  const [text, setText] = useState(value === null ? '' : format(value));
  const [error, setError] = useState<string | null>(null);
  const emitted = useRef<T | null>(value);
  const emittedValidity = useRef<FieldValidity>(VALID);
  const latest = useRef({ format, parse, onChange });

  useEffect(() => {
    latest.current = { format, parse, onChange };
  });

  useEffect(() => {
    if (Object.is(value, emitted.current)) return;
    emitted.current = value;
    emittedValidity.current = VALID;
    setText(value === null ? '' : latest.current.format(value));
    setError(null);
  }, [value]);

  const seenResetKey = useRef(resetKey);
  useEffect(() => {
    if (Object.is(seenResetKey.current, resetKey)) return;
    seenResetKey.current = resetKey;
    emitted.current = value;
    emittedValidity.current = VALID;
    setText(value === null ? '' : latest.current.format(value));
    setError(null);
  }, [resetKey, value]);

  const onTextChange = useCallback((next: string) => {
    setText(next);
    setError(null);
  }, []);

  const commit = useCallback(
    (override?: string) => {
      const outcome = latest.current.parse(override ?? text);
      const next = outcome.ok ? outcome.value : null;
      const validity: FieldValidity = outcome.ok ? VALID : { valid: false, reason: outcome.reason };
      if (outcome.ok) {
        setError(null);
        setText(next === null ? '' : latest.current.format(next));
      } else {
        setError(outcome.reason);
      }
      const before = emittedValidity.current;
      if (Object.is(next, emitted.current) && before.valid === validity.valid && before.reason === validity.reason) {
        return;
      }
      emitted.current = next;
      emittedValidity.current = validity;
      latest.current.onChange(next, validity);
    },
    [text],
  );

  return { text, error, onTextChange, commit };
}
