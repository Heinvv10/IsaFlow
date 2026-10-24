/**
 * ExplainDrawer — "How was this calculated?" for a tax or payroll figure.
 * Renders an Explanation supplied by the engine that produced the number; it never computes,
 * rounds or reformats a value. A modal dialog: labelled, focus trapped, Esc closes.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useFocusTrap } from './useFocusTrap';

export interface ExplanationLine {
  label: string;
  formula?: string;
  value: string | number;
  source?: string;
}

export interface Explanation {
  title: string;
  lines: ExplanationLine[];
  caution?: string;
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
          <dl className="divide-y divide-gray-100 dark:divide-white/[0.08]">
            {explanation.lines.map((line, i) => (
              <div key={`${i}-${line.label}`} className="py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm font-medium text-gray-900 dark:text-gray-100">{line.label}</dt>
                  <dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{line.value}</dd>
                </div>
                {line.formula && (
                  <p className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">{line.formula}</p>
                )}
                {line.source && <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">Source: {line.source}</p>}
              </div>
            ))}
          </dl>
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
