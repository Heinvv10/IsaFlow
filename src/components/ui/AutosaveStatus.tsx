/**
 * AutosaveStatus — "Saved 2 s ago" / "Saving…" / "Unsaved changes" / "Couldn't save".
 * A polite live region, so a screen reader hears the state change but not every tick of the clock.
 */
import * as React from 'react';
import { AlertCircle, Check, Loader2, Pencil } from 'lucide-react';
import { cn } from '@/utils/cn';

export type AutosaveState = 'saved' | 'saving' | 'dirty' | 'error';

export interface AutosaveStatusProps {
  state: AutosaveState;
  /** When the last save finished (ms since epoch or Date). Needed for state 'saved'. */
  savedAt?: number | Date | null;
  /** Shown instead of "Couldn't save" when state is 'error'. */
  errorMessage?: string;
  className?: string;
}

/** "just now", "2 s ago", "3 min ago", "2 h ago". */
export function formatSavedAgo(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function AutosaveStatus({ state, savedAt, errorMessage, className }: AutosaveStatusProps) {
  const savedMs = savedAt === null || savedAt === undefined ? null : new Date(savedAt).getTime();
  const now = useNow(state === 'saved' && savedMs !== null);

  let icon = <Check size={14} aria-hidden="true" />;
  let text = 'Saved';
  let tone = 'text-gray-600 dark:text-gray-400';
  if (state === 'saved' && savedMs !== null) text = `Saved ${formatSavedAgo(now - savedMs)}`;
  if (state === 'saving') {
    icon = <Loader2 size={14} aria-hidden="true" className="animate-spin" />;
    text = 'Saving…';
  } else if (state === 'dirty') {
    icon = <Pencil size={14} aria-hidden="true" />;
    text = 'Unsaved changes';
    tone = 'text-amber-800 dark:text-amber-300';
  } else if (state === 'error') {
    icon = <AlertCircle size={14} aria-hidden="true" />;
    text = errorMessage ?? "Couldn't save";
    tone = 'text-red-700 dark:text-red-400';
  }

  return (
    <p role="status" className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone, className)}>
      {icon}
      <span>{text}</span>
    </p>
  );
}
