/**
 * FieldFrame — label, control slot, echo, helper and error text for the kit's parsed fields.
 * The control must carry `id` and `aria-describedby={describedBy(...)}` so the label, the echo
 * and the error are all announced with it.
 */
import * as React from 'react';
import { FieldHelp, type FieldHelpContent } from './FieldHelp';

export interface FieldFrameProps {
  id: string;
  label: string;
  /** Visually hidden label (still the control's accessible name). */
  labelHidden?: boolean;
  required?: boolean;
  /** Show the * for a required field (default). A filter that only wants its empty box refused turns it off. */
  requiredMark?: boolean;
  error?: string | null;
  helperText?: string;
  /** A non-blocking caution (amber, announced politely). Hidden while there is an error. */
  warning?: string | null;
  /** What the parser understood, e.g. "R 25 000.00". Hidden while there is an error. */
  echo?: string | null;
  /** Contextual help: an (i) button with a tooltip and an optional "Learn more" link. */
  help?: FieldHelpContent;
  children: React.ReactNode;
}

const fieldIds = (id: string) => ({
  error: `${id}-error`,
  helper: `${id}-helper`,
  help: `${id}-help`,
  echo: `${id}-echo`,
  warning: `${id}-warning`,
});

/** The aria-describedby value for the pieces FieldFrame is currently showing. */
export function describedBy(
  id: string,
  { error, helperText, echo, help, warning }: Pick<FieldFrameProps, 'error' | 'helperText' | 'echo' | 'help' | 'warning'>,
): string | undefined {
  const ids = fieldIds(id);
  const parts = [help ? ids.help : null, error ? ids.error : null, !error && echo ? ids.echo : null, !error && warning ? ids.warning : null, !error && helperText ? ids.helper : null];
  return parts.filter(Boolean).join(' ') || undefined;
}

export function FieldFrame({ id, label, labelHidden, required, requiredMark = true, error, helperText, echo, warning, help, children }: FieldFrameProps) {
  const ids = fieldIds(id);
  return (
    <div className="flex flex-col gap-1">
      <div className={labelHidden && !help ? 'sr-only' : 'flex items-center gap-1.5'}>
        <label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-sm font-medium text-gray-700 dark:text-gray-300'}>
          {label}
          {required && requiredMark && (
            <span aria-hidden="true" className="ml-0.5 text-red-600 dark:text-red-400">
              *
            </span>
          )}
        </label>
        {help && <FieldHelp help={help} textId={ids.help} subject={label} />}
      </div>
      {children}
      {!error && echo && (
        <p
          id={ids.echo}
          aria-live="polite"
          className="text-xs font-medium tabular-nums text-teal-700 dark:text-teal-300"
        >
          {echo}
        </p>
      )}
      {!error && helperText && (
        <p id={ids.helper} className="text-xs text-gray-600 dark:text-gray-400">
          {helperText}
        </p>
      )}
      {!error && warning && (
        <p id={ids.warning} role="status" className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}
      {error && (
        <p id={ids.error} role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
