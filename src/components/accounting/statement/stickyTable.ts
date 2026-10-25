/**
 * Sticky-table classes for report grids (statements, trial balance, general ledger).
 *
 * The PAGE is the one scroll container (AppLayout's <main>): a wide report scrolls sideways with
 * the page and a long one scrolls down with it, so the header row sticks to the top of <main> and
 * the first column to its left edge. That only works while nothing between the table and <main>
 * is itself a scroll container - no overflow-hidden/auto/scroll wrapper, no max-height box (a
 * nested box traps the wheel and never engages when the page is the thing scrolling). Use
 * overflow-clip, which does not make a scroll container, where corners must be rounded.
 * Cells need an opaque surface or the scrolled-under content shows through them. print:static
 * keeps a printed or PDF report in normal flow.
 * Written out in full: Tailwind's content scan cannot see a class built from parts.
 */
export const STICKY_HEAD =
  'sticky top-0 z-20 bg-[var(--ff-bg-secondary)] shadow-[inset_0_-1px_0_var(--ff-border-secondary)] print:static';
export const STICKY_FIRST_HEAD =
  'sticky left-0 top-0 z-30 bg-[var(--ff-bg-secondary)] shadow-[inset_0_-1px_0_var(--ff-border-secondary)] print:static';
export const STICKY_FIRST_CELL = 'sticky left-0 z-10 bg-[var(--ff-bg-secondary)] print:static';
