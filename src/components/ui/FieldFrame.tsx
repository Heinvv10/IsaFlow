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
  required?: boolean;
  error?: string | null;
  helperText?: string;
  /** What the parser understood, e.g. "R 25 000.00". Hidden while there is an error. */
  echo?: string | null;
  /** Contextual help: an (i) button with a tooltip and an optional "Learn more" link. */
  help?: FieldHelpContent;
  children: React.ReactNode;
}

export const fieldIds = (id: string) => ({
  error: `${id}-error`,
  helper: `${id}-helper`,
  help: `${id}-help`,
  echo: `${id}-echo`,
});

/** The aria-describedby value for the pieces FieldFrame is currently showing. */
export function describedBy(
  id: string,
  { error, helperText, echo, help }: Pick<FieldFrameProps, 'error' | 'helperText' | 'echo' | 'help'>,
): string | undefined {
  const ids = fieldIds(id);
  const parts = [help ? ids.help : null, error ? ids.error : null, !error && echo ? ids.echo : null, !error && helperText ? ids.helper : null];
  return parts.filter(Boolean).join(' ') || undefined;
}

export function FieldFrame({ id, label, required, error, helperText, echo, help, children }: FieldFrameProps) {
  const ids = fieldIds(id);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && (
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
      {error && (
        <p id={ids.error} role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
