/**
 * MonthPopup — the optional month picker of a MonthField. Opens only from the field's button or Alt+ArrowDown. A modal
 * dialog with a year header (previous / next year) and a 3 x 4 grid of months with one roving tab stop: arrows move a
 * month or a row, Home / End the row ends, PageUp / PageDown a year, Enter or Space picks, Escape closes. Below lg it is a
 * bottom sheet with 44px targets, from lg up a popover under the field. Months outside min / max are aria-disabled.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import { addMonths, clampMonth } from '@/lib/monthParser';
import { usePopupPanel } from './usePopupPanel';

export interface MonthPopupProps {
  anchor: HTMLElement | null;
  trigger: HTMLElement | null;
  /** The month the field holds, 'YYYY-MM', or null. */
  selected: string | null;
  /** Where the grid opens and focus lands. */
  start: string;
  /** This month, 'YYYY-MM'. */
  today: string;
  minMonth?: string;
  maxMonth?: string;
  onPick: (ym: string) => void;
  onClose: (restoreFocus: boolean) => void;
}

const PANEL_HEIGHT = 330;
const PANEL_WIDTH = 288;
const HINT = 'Type Mar 2026 or 03/2026 · t this month · +1 / -1 months';
const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const navClass = 'inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-40 ff-focus-ring dark:text-gray-300 dark:hover:bg-gray-700';
const pad = (n: number) => String(n).padStart(2, '0');

export function MonthPopup({ anchor, trigger, selected, start, today, minMonth, maxMonth, onPick, onClose }: MonthPopupProps) {
  const { sheet, ref, style } = usePopupPanel({ anchor, trigger, onClose, panelHeight: PANEL_HEIGHT, panelWidth: PANEL_WIDTH });
  const [focusYm, setFocusYm] = useState(() => clampMonth(start, minMonth, maxMonth));
  const grabFocus = useRef(true);
  const year = Number(focusYm.slice(0, 4));

  useEffect(() => {
    if (!grabFocus.current) return;
    ref.current?.querySelector<HTMLElement>(`[data-ym="${focusYm}"]`)?.focus();
  }, [focusYm, ref]);

  const off = (v: string): boolean => Boolean((minMonth && v < minMonth) || (maxMonth && v > maxMonth));
  const goTo = (v: string): void => { grabFocus.current = true; setFocusYm(clampMonth(v, minMonth, maxMonth)); };
  const shiftYear = (n: number): void => {
    grabFocus.current = false;
    setFocusYm(clampMonth(addMonths(focusYm, n * 12), minMonth, maxMonth));
  };

  const onGridKey = (e: KeyboardEvent<HTMLElement>): void => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(focusYm); return; } // focus is always clamped into the bounds, so it is never on a disabled month
    const col = (Number(focusYm.slice(5)) - 1) % 3;
    const step: Record<string, number> = {
      ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3, PageDown: 12, PageUp: -12, Home: -col, End: 2 - col,
    };
    const n = step[e.key];
    if (n === undefined) return;
    e.preventDefault();
    goTo(addMonths(focusYm, n));
  };

  const prevOk = !(minMonth && `${year - 1}-12` < minMonth);
  const nextOk = !(maxMonth && `${year + 1}-01` > maxMonth);
  const cellSize = sheet ? 'h-11 min-h-11' : 'h-10';

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Choose month"
      data-layout={sheet ? 'sheet' : 'popover'}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={sheet ? undefined : style}
      className={cn(
        'z-[70] flex flex-col gap-2 border border-gray-200 bg-white p-3 text-gray-900 shadow-xl dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100',
        sheet ? 'fixed inset-x-0 bottom-0 rounded-t-xl pb-[max(0.75rem,env(safe-area-inset-bottom))]' : 'rounded-lg',
      )}
    >
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous year" disabled={!prevOk} onClick={() => shiftYear(-1)} className={navClass}><ChevronLeft size={16} aria-hidden="true" /></button>
        <h2 aria-live="polite" className="flex-1 text-center text-sm font-semibold tabular-nums">{year}</h2>
        <button type="button" aria-label="Next year" disabled={!nextOk} onClick={() => shiftYear(1)} className={navClass}><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <table role="grid" aria-label={`Months of ${year}`} className="w-full border-collapse text-center text-sm" onKeyDown={onGridKey}>
        <tbody>
          {[0, 1, 2, 3].map((row) => (
            <tr key={row}>
              {[0, 1, 2].map((col) => {
                const m = row * 3 + col + 1;
                const v = `${year}-${pad(m)}`;
                const disabled = off(v);
                const isSel = v === selected;
                return (
                  <td
                    key={v}
                    role="gridcell"
                    data-ym={v}
                    aria-label={`${NAMES[m - 1]} ${year}`}
                    aria-selected={isSel}
                    aria-current={v === today ? 'date' : undefined}
                    aria-disabled={disabled || undefined}
                    tabIndex={v === focusYm ? 0 : -1}
                    onClick={() => { if (!disabled) onPick(v); }}
                    onFocus={() => { grabFocus.current = true; if (v !== focusYm) setFocusYm(v); }}
                    className={cn(
                      cellSize, 'cursor-pointer rounded-md ff-focus-ring hover:bg-gray-100 dark:hover:bg-gray-700',
                      v === today && 'font-bold ring-1 ring-teal-500',
                      isSel && 'bg-brand-600 text-white hover:bg-brand-700',
                      disabled && 'cursor-not-allowed opacity-40 line-through hover:bg-transparent',
                    )}
                  >
                    <span aria-hidden="true">{NAMES[m - 1]?.slice(0, 3)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={off(today)} onClick={() => onPick(today)} className="h-9 rounded-md border border-gray-300 px-3 text-sm ff-focus-ring disabled:opacity-40 dark:border-gray-600">This month</button>
        <button type="button" onClick={() => onClose(true)} className="h-9 rounded-md px-3 text-sm text-gray-700 ff-focus-ring dark:text-gray-300">Close</button>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">{HINT}</p>
    </div>
  );

  return createPortal(
    <>{sheet && <div aria-hidden="true" className="fixed inset-0 z-[69] bg-black/40" onClick={(e) => { e.stopPropagation(); onClose(false); }} />}{body}</>,
    document.body,
  );
}
