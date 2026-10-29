/**
 * The override indicator on a grid cell typed over its row's driver (P4 spec §1.2, §7): a corner
 * mark, and on hover or while the cell has focus "Override of driver value R x · Reset". The
 * driver value is computed when the note shows (the pure engine, `driverPreview.driverValueOf`),
 * never on every render. Reset is a mouse target here; keyboard users reach the same reset from
 * the row's actions (Shift+F10 on the cell: "Reset <month> to driver"), which the cell's
 * accessible name says. The note is placed in the viewport (fixed, clamped to its edges), so a
 * cell near the edge of a phone screen or under the sticky account column still shows it whole.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
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
const EDGE = 8;

/** Below the mark, right-aligned to it, kept inside the viewport. */
function place(mark: DOMRect, width: number): CSSProperties {
  const left = Math.min(Math.max(mark.right - width, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE));
  // Touching the mark: the pointer moves from the mark into the note without leaving it (no gap closes it).
  return { top: mark.bottom, left };
}

export function OverrideMark({ focused, valueOf, onReset }: OverrideMarkProps) {
  const [hover, setHover] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const markRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  const open = hover || focused;
  useLayoutEffect(() => {
    if (!open || !markRef.current || !noteRef.current) return;
    setStyle(place(markRef.current.getBoundingClientRect(), noteRef.current.offsetWidth));
  }, [open]);
  return (
    <span ref={markRef} data-testid="override-mark" className="absolute right-0 top-0 h-3 w-3" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span aria-hidden="true" className="absolute right-0 top-0 h-0 w-0 border-l-[7px] border-t-[7px] border-l-transparent border-t-[var(--ff-unfav)]" />
      {open && (
        <span ref={noteRef} role="tooltip" data-testid="override-note" onMouseDown={stop} onDoubleClick={stop} style={style}
          className="fixed z-40 flex items-center gap-1.5 whitespace-nowrap rounded border border-[var(--ff-border-secondary)] bg-[var(--ff-bg-secondary)] px-2 py-1 text-xs font-normal not-italic text-[var(--ff-text-primary)] shadow-lg">
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
