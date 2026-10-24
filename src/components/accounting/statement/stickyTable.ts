/**
 * Sticky-table classes for report grids (statements, trial balance, general ledger).
 *
 * The wrapper is the scroll container, so the header sticks to its top and the first column to
 * its left on horizontal scroll. It is capped to the viewport so a long report scrolls inside it
 * with the header in view; print drops the cap so a printed or PDF report is never clipped.
 * Cells need an opaque surface or the scrolled-under content shows through them.
 * Written out in full: Tailwind's content scan cannot see a class built from parts.
 */
export const STICKY_WRAP = 'overflow-auto max-h-[calc(100vh-14rem)] print:max-h-none print:overflow-visible';
export const STICKY_HEAD =
  'sticky top-0 z-20 bg-[var(--ff-bg-secondary)] shadow-[inset_0_-1px_0_var(--ff-border-secondary)] print:static';
export const STICKY_FIRST_HEAD =
  'sticky left-0 top-0 z-30 bg-[var(--ff-bg-secondary)] shadow-[inset_0_-1px_0_var(--ff-border-secondary)] print:static';
export const STICKY_FIRST_CELL = 'sticky left-0 z-10 bg-[var(--ff-bg-secondary)] print:static';
