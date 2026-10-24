/**
 * useParsedField — text-in, typed-value-out state shared by MoneyField and DateField.
 *
 * The user types free text; it is parsed ONCE on commit (blur / Enter). The parent only ever
 * sees the parsed value (or null when the text is empty or not understood), never a half-typed
 * string. An outside change to `value` replaces the text; the echo of our own commit does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ParseOutcome<T> = { ok: true; value: T | null } | { ok: false; reason: string };

interface Options<T> {
  value: T | null;
  format: (value: T) => string;
  parse: (text: string) => ParseOutcome<T>;
  onChange: (value: T | null) => void;
}

export interface ParsedField {
  text: string;
  /** Reason the last commit was refused; cleared as soon as the user types again. */
  error: string | null;
  onTextChange: (text: string) => void;
  /** Parse `override ?? text` now and report the result to the parent. */
  commit: (override?: string) => void;
}

export function useParsedField<T>({ value, format, parse, onChange }: Options<T>): ParsedField {
  const [text, setText] = useState(value === null ? '' : format(value));
  const [error, setError] = useState<string | null>(null);
  const emitted = useRef<T | null>(value);
  const latest = useRef({ format, parse, onChange });
  useEffect(() => {
    latest.current = { format, parse, onChange };
  });

  useEffect(() => {
    if (Object.is(value, emitted.current)) return;
    emitted.current = value;
    setText(value === null ? '' : latest.current.format(value));
    setError(null);
  }, [value]);

  const onTextChange = useCallback((next: string) => {
    setText(next);
    setError(null);
  }, []);

  const commit = useCallback(
    (override?: string) => {
      const source = override ?? text;
      const outcome = latest.current.parse(source);
      const next = outcome.ok ? outcome.value : null;
      if (outcome.ok) {
        setError(null);
        setText(next === null ? '' : latest.current.format(next));
      } else {
        setError(outcome.reason);
      }
      if (!Object.is(next, emitted.current)) {
        emitted.current = next;
        latest.current.onChange(next);
      }
    },
    [text],
  );

  return { text, error, onTextChange, commit };
}
