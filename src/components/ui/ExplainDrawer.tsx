/**
 * ExplainDrawer — "How was this calculated?" for a tax or payroll figure.
 * Renders an Explanation supplied by the engine that produced the number; it never computes,
 * rounds or reformats a value. A modal dialog: labelled, focus trapped, Esc closes.
 *
 * Why not the existing `Drawer`: it has no focus trap and no aria-labelledby, and five screens depend on
 * that exact behaviour; this one needs both. Fold them together in a change that owns those five screens.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useFocusTrap } from './useFocusTrap';
import { isExternalHref, safeHref } from './safeHref';

export type ExplanationStatus = 'verified' | 'unverified' | 'estimate';

export interface ExplanationSource {
  label: string;
  /** Rendered as a link only when it is http(s) or an in-app path (see safeHref). */
  href?: string;
  /** Tax year the rule or table belongs to, e.g. "2026/27". */
  taxYear?: string;
}

export interface ExplanationLine {
  label: string;
  formula?: string;
  value: string | number;
  /** Shown after the value, e.g. "per month", "%". */
  unit?: string;
  /** Said in words next to the line, not by colour alone. */
  status?: ExplanationStatus;
  source?: string | ExplanationSource;
  /** The steps this line is built from, shown nested under it. */
  children?: ExplanationLine[];
}

export interface Explanation {
  title: string;
  lines: ExplanationLine[];
  /** The figure the lines add up to; shown last and set apart. */
  result?: ExplanationLine;
  /** When the engine produced this, already formatted for display ("25 Oct 2026"). */
  asOf?: string;
  caution?: string;
}

const STATUS_TEXT: Record<ExplanationStatus, string> = {
  verified: 'Verified',
  unverified: 'Unverified',
  estimate: 'Estimate',
};

function SourceText({ source }: { source: string | ExplanationSource }) {
  if (typeof source === 'string') return <>Source: {source}</>;
  const href = safeHref(source.href);
  const label = source.taxYear ? `${source.label} (${source.taxYear})` : source.label;
  return (
    <>
      Source:{' '}
      {href ? (
        <a
          href={href}
          {...(isExternalHref(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="ff-focus-ring font-medium text-teal-700 underline dark:text-teal-300"
        >
          {label}
          {isExternalHref(href) && <span className="sr-only"> (opens in a new tab)</span>}
        </a>
      ) : (
        label
      )}
    </>
  );
}

function Line({ line, strong }: { line: ExplanationLine; strong?: boolean }) {
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {line.label}
          {line.status && (
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              {STATUS_TEXT[line.status]}
            </span>
          )}
        </dt>
        <dd className={cn('text-sm tabular-nums text-gray-900 dark:text-gray-100', strong ? 'font-bold' : 'font-semibold')}>
          {line.value}
          {line.unit && <span className="ml-1 text-xs font-normal text-gray-600 dark:text-gray-400">{line.unit}</span>}
        </dd>
      </div>
      {line.formula && <p className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">{line.formula}</p>}
      {line.source && (
        <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          <SourceText source={line.source} />
        </p>
      )}
      {line.children && line.children.length > 0 && (
        <dl className="mt-1 divide-y divide-gray-100 border-l-2 border-gray-200 pl-3 dark:divide-white/[0.08] dark:border-gray-700">
          {line.children.map((child, i) => (
            <Line key={`${i}-${child.label}`} line={child} />
          ))}
        </dl>
      )}
    </div>
  );
}

export interface ExplainDrawerProps {
  open: boolean;
  onClose: () => void;
  explanation: Explanation;
  className?: string;
}

export function ExplainDrawer({ open, onClose, explanation, className }: ExplainDrawerProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(panelRef, open, onClose);

  React.useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'relative flex h-full w-full max-w-md flex-col bg-white shadow-xl dark:bg-gray-900',
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-white/[0.08]">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {explanation.title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ff-focus-ring rounded-md p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {explanation.asOf && (
            <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">As of {explanation.asOf}</p>
          )}
          <dl className="divide-y divide-gray-100 dark:divide-white/[0.08]">
            {explanation.lines.map((line, i) => (
              <Line key={`${i}-${line.label}`} line={line} />
            ))}
          </dl>
          {explanation.result && (
            <dl className="mt-2 border-t-2 border-gray-300 dark:border-gray-600">
              <Line line={explanation.result} strong />
            </dl>
          )}
          {explanation.caution && (
            <p
              role="note"
              className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {explanation.caution}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
