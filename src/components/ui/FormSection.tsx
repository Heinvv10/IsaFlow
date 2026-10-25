/**
 * FormSection — a numbered section of a long form: heading, optional sticky summary column,
 * and (with AutosaveStatus) the "Saved 2 s ago" indicator for drafts.
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { FieldHelp, type FieldHelpContent } from './FieldHelp';

export interface FormSectionProps {
  /** Step number shown in the badge ("1"). Omit for an unnumbered section. */
  number?: number;
  title: string;
  description?: string;
  /** (i) tooltip next to the heading, with an optional "Learn more" link. */
  help?: FieldHelpContent;
  /** Sticky column beside the fields, e.g. totals. Stacks below the fields on small screens. */
  summary?: React.ReactNode;
  /** Accessible name of the summary column. */
  summaryLabel?: string;
  /** Right-aligned slot in the heading row, e.g. <AutosaveStatus />. */
  status?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function FormSection({
  number, title, description, help, summary, summaryLabel = 'Summary', status, className, children,
}: FormSectionProps) {
  const headingId = React.useId();
  const helpId = `${headingId}-help`;
  return (
    <section aria-labelledby={headingId} aria-describedby={help ? helpId : undefined} className={cn('py-4', className)}>
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {number !== undefined && (
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white dark:bg-teal-400 dark:text-gray-900"
            >
              {number}
            </span>
          )}
          <div>
            <div className="flex items-center gap-1.5">
              <h2 id={headingId} className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {number !== undefined && <span className="sr-only">Step {number}: </span>}
                {title}
              </h2>
              {help && <FieldHelp help={help} textId={helpId} subject={title} />}
            </div>
            {description && <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{description}</p>}
          </div>
        </div>
        {status}
      </header>
      <div className={cn(summary ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]' : undefined)}>
        <div className="space-y-4">{children}</div>
        {summary && (
          <aside aria-label={summaryLabel} className="self-start lg:sticky lg:top-4">
            {summary}
          </aside>
        )}
      </div>
    </section>
  );
}
