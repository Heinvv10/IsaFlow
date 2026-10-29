/**
 * The override indicator on a grid cell typed over its row's driver (P4 spec §1.2, §7): a corner
 * mark, and on hover or while the cell has focus "Override of driver value R x · Reset". The
 * driver value is computed when the note shows (the pure engine, `driverPreview.driverValueOf`),
 * never on every render. Reset is a mouse target here; keyboard users reach the same reset from
 * the row's actions (Shift+F10 on the cell: "Reset <month> to driver"), which the cell's
 * accessible name says.
 */
import { useState, type MouseEvent } from 'react';
import { formatCents } from '@/lib/money/formatMoney';

export interface OverrideMarkProps {
  /** The cell has the grid's focus: the note shows without a hover. */
  focused: boolean;
  /** The driver's value for this cell now, in cents; null when it cannot be computed here. */
  valueOf(): number | null;
  /** Null: no Reset (a reader, or a locked version). */
  onReset: (() => void) | null;
}

export function overrideText(value: number | null): string {
  return value === null ? "Override of the driver's value" : `Override of driver value ${formatCents(value)}`;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function OverrideMark({ focused, valueOf, onReset }: OverrideMarkProps) {
  const [hover, setHover] = useState(false);
  const open = hover || focused;
  return (
    <span data-testid="override-mark" className="absolute right-0 top-0 h-3 w-3" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span aria-hidden="true" className="absolute right-0 top-0 h-0 w-0 border-l-[7px] border-t-[7px] border-l-transparent border-t-[var(--ff-unfav)]" />
      {open && (
        <span role="tooltip" data-testid="override-note" onMouseDown={stop} onDoubleClick={stop}
          className="absolute right-0 top-3 z-30 flex items-center gap-1.5 whitespace-nowrap rounded border border-[var(--ff-border-secondary)] bg-[var(--ff-bg-secondary)] px-2 py-1 text-xs font-normal not-italic text-[var(--ff-text-primary)] shadow-lg">
          <span>{overrideText(valueOf())}</span>
          {onReset && (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onReset(); }}
                className="underline hover:text-[var(--ff-brand-eyebrow)]" data-testid="override-reset">Reset</button>
            </>
          )}
        </span>
      )}
    </span>
  );
}
