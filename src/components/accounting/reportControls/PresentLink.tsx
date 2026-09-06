/**
 * The way into presentation mode.
 *
 * `pages/accounting/reports/present/[pack].tsx` takes a pack type and a date
 * range and has no standalone destination — opened without them it can only
 * report "Unknown pack". It therefore needs an entry point that already
 * knows a period, and a statement page is exactly that: the reader is looking
 * at a period, and this hands the same one to the deck.
 *
 * Same tab on purpose. Presentation mode is full screen with no app chrome;
 * a new tab would leave the presenter's own window behind the projected one.
 */
import Link from 'next/link';
import { MonitorPlay } from 'lucide-react';

/** The pack a statement page presents. `management` is the one whose sections
 *  the deck has renderers for — income statement, waterfall, trends, ratios. */
export const PRESENT_PACK = 'management';

export function presentHref(from: string, to: string): string {
  return `/accounting/reports/present/${PRESENT_PACK}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

const CLASSES =
  'inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 ' +
  'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg ' +
  'hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium';

export function PresentLink({ from, to }: { from: string; to: string }) {
  // Without both bounds the deck can only render its "Unknown pack" error, so
  // the control is inert rather than a link to a page that reports a fault.
  if (!from || !to) {
    return (
      <span className={`${CLASSES} opacity-50`} aria-disabled="true">
        <MonitorPlay className="h-4 w-4" /> Present
      </span>
    );
  }
  return (
    <Link href={presentHref(from, to)} className={CLASSES}>
      <MonitorPlay className="h-4 w-4" /> Present
    </Link>
  );
}
