/**
 * ActionRow — one row inside a Feed: leading badge, title/subtitle stack,
 * optional ZAR amount (via Money), trailing meta + chevron.
 * With an onClick it renders an interactive, keyboard-focusable <button>
 * (hover + focus ring + chevron); without one it renders a plain, non-interactive
 * row (no chevron) so informational rows don't give a false click affordance.
 */
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { Money } from './Money';
import { cn } from '@/utils/cn';

export interface ActionRowProps {
  /** Leading element — typically a severity badge or icon. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** ZAR amount; rendered via <Money> when a number, hidden when null/undefined. */
  amount?: number | null;
  /** Trailing context, e.g. a due date. */
  meta?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

export function ActionRow({ leading, title, subtitle, amount, meta, onClick, className }: ActionRowProps) {
  const interactive = onClick != null;
  const body = (
    <>
      {leading && <div className="flex-shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--ff-text-primary)]">{title}</div>
        {subtitle && <div className="truncate text-xs text-[var(--ff-text-tertiary)]">{subtitle}</div>}
      </div>
      {amount != null && (
        <Money amount={amount} className="flex-shrink-0 text-sm text-[var(--ff-text-secondary)]" />
      )}
      {meta && (
        <div className="flex-shrink-0 whitespace-nowrap text-sm text-[var(--ff-text-secondary)]">{meta}</div>
      )}
      {interactive && (
        <ArrowRight className="h-4 w-4 flex-shrink-0 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
      )}
    </>
  );

  const base = 'flex w-full items-center gap-3 px-4 py-3 text-left';

  if (!interactive) {
    return <div className={cn(base, className)}>{body}</div>;
  }

  return (
    // ring-inset keeps the focus ring inside the Card border instead of bleeding past it
    <button
      type="button"
      onClick={onClick}
      className={cn(
        base,
        'transition-colors hover:bg-[var(--ff-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500',
        className,
      )}
    >
      {body}
    </button>
  );
}

ActionRow.displayName = 'ActionRow';
