/**
 * CalendarPopup — the optional calendar of a DateField. Typing stays the primary way in; this opens only from the
 * field's calendar button or Alt+ArrowDown, never on focus. A modal dialog (W3C APG "date picker dialog"): a Monday-first
 * grid with one roving tab stop, arrows / Home / End / PageUp / PageDown / Shift+PageUp / Shift+PageDown, Enter or
 * Space to pick, Escape to close. Below lg it is a bottom sheet with 44px day targets; at lg and up a popover under the field.
 * Days outside minDate / maxDate are disabled (aria-disabled) and keyboard movement stops at them.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import { localDateFromISO } from '@/lib/dateUtils';
import { formatDisplayDateWeekday } from '@/utils/dateFormat';
import { useFocusTrap } from './useFocusTrap';
import { chooseSide, placePanel } from './panelPlacement';
import {
  addMonthsISO, clampToBounds, monthGrid, monthLabel, monthName, moveByKey, shiftMonth, WEEKDAYS, type YearMonth,
} from './calendarMath';

export interface CalendarPopupProps {
  /** The field the popover hangs under (viewport rect read when it opens). */
  anchor: HTMLElement | null;
  /** Date the field holds, ISO, or null. */
  selected: string | null;
  /** Where the grid opens and focus lands: the selected date, a readable typed one, else today. */
  start: string;
  today: string;
  minDate?: string;
  maxDate?: string;
  onPick: (iso: string) => void;
  onClose: () => void;
}

const SHEET_QUERY = '(max-width: 1023.98px)';
const PANEL_HEIGHT = 360;
const PANEL_WIDTH = 288;
const HINT = 'Type 15 or 15/3 or 15/03/2026 · t today · +30 days · eom month end';
const selectClass = 'h-9 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-900 ff-focus-ring dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const navClass = 'inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-40 ff-focus-ring dark:text-gray-300 dark:hover:bg-gray-700';

function useIsSheet(): boolean {
  const [sheet, setSheet] = useState<boolean>(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHEET_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(SHEET_QUERY);
    const on = (): void => setSheet(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return sheet;
}

const ymOf = (iso: string): YearMonth => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return { year: y, month: m };
};

export function CalendarPopup({ anchor, selected, start, today, minDate, maxDate, onPick, onClose }: CalendarPopupProps) {
  const sheet = useIsSheet();
  const ref = useRef<HTMLDivElement>(null);
  const [focusIso, setFocusIso] = useState(() => clampToBounds(start, minDate, maxDate));
  const [view, setView] = useState<YearMonth>(() => ymOf(clampToBounds(start, minDate, maxDate)));
  const grabFocus = useRef(true);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  useFocusTrap(ref, true, onClose);

  // Close on a press outside; a press on the calendar button is the button's own toggle, so it is not "outside".
  useEffect(() => {
    const down = (e: MouseEvent | TouchEvent): void => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('touchstart', down); };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    if (sheet || !anchor) { setStyle(undefined); return; }
    const r = anchor.getBoundingClientRect();
    const side = chooseSide(r, window.innerHeight, PANEL_HEIGHT);
    const p = placePanel(r, window.innerHeight, side);
    setStyle({ position: 'fixed', left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8)), top: p.top, bottom: p.bottom, maxHeight: p.maxHeight, width: PANEL_WIDTH });
  }, [sheet, anchor]);

  // Focus follows the roving stop only when the user is navigating the grid (not while they use the month / year controls).
  useEffect(() => {
    if (!grabFocus.current) return;
    ref.current?.querySelector<HTMLElement>(`[data-iso="${focusIso}"]`)?.focus();
  }, [focusIso, view]);

  const off = (iso: string): boolean => Boolean((minDate && iso < minDate) || (maxDate && iso > maxDate));
  const goTo = (iso: string): void => {
    const next = clampToBounds(iso, minDate, maxDate);
    grabFocus.current = true;
    setFocusIso(next);
    setView(ymOf(next));
  };
  const shiftView = (ym: YearMonth): void => {
    grabFocus.current = false;
    setView(ym);
    const [y, m] = focusIso.split('-').map(Number) as [number, number];
    setFocusIso(clampToBounds(addMonthsISO(focusIso, (ym.year * 12 + ym.month) - (y * 12 + m)), minDate, maxDate));
  };
  const monthOk = (ym: YearMonth): boolean => {
    const first = `${String(ym.year).padStart(4, '0')}-${String(ym.month).padStart(2, '0')}-01`;
    const last = `${String(ym.year).padStart(4, '0')}-${String(ym.month).padStart(2, '0')}-${new Date(ym.year, ym.month, 0).getDate()}`;
    return !((maxDate && first > maxDate) || (minDate && last < minDate));
  };

  const onGridKey = (e: KeyboardEvent<HTMLElement>): void => {
    e.stopPropagation(); // a parent form / row must not also read these keys
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!off(focusIso)) onPick(focusIso);
      return;
    }
    const to = moveByKey(focusIso, e.key, e.shiftKey);
    if (to === null) return;
    e.preventDefault();
    goTo(to);
  };

  const yearFrom = minDate ? Number(minDate.slice(0, 4)) : Math.min(Number(today.slice(0, 4)) - 40, view.year);
  const yearTo = maxDate ? Number(maxDate.slice(0, 4)) : Math.max(Number(today.slice(0, 4)) + 15, view.year);
  const years = Array.from({ length: Math.max(yearTo, view.year) - Math.min(yearFrom, view.year) + 1 }, (_, i) => Math.min(yearFrom, view.year) + i);
  const prev = shiftMonth(view, -1);
  const next = shiftMonth(view, 1);
  const grid = monthGrid(view.year, view.month);
  const todayOff = off(today);
  const cellSize = sheet ? 'h-11 min-h-11' : 'h-8';

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Choose date"
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
        <button type="button" aria-label="Previous month" disabled={!monthOk(prev)} onClick={() => shiftView(prev)} className={navClass}><ChevronLeft size={16} aria-hidden="true" /></button>
        <h2 aria-live="polite" className="flex-1 text-center text-sm font-semibold">{monthLabel(view.year, view.month)}</h2>
        <button type="button" aria-label="Next month" disabled={!monthOk(next)} onClick={() => shiftView(next)} className={navClass}><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <div className="flex gap-2">
        <select aria-label="Month" value={view.month} onChange={(e) => shiftView({ year: view.year, month: Number(e.target.value) })} className={cn(selectClass, 'flex-1')}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m} disabled={!monthOk({ year: view.year, month: m })}>{monthName(m)}</option>)}
        </select>
        <select aria-label="Year" value={view.year} onChange={(e) => shiftView({ year: Number(e.target.value), month: view.month })} className={cn(selectClass, 'w-24')}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <table role="grid" aria-label={monthLabel(view.year, view.month)} className="w-full border-collapse text-center text-sm" onKeyDown={onGridKey}>
        <thead>
          <tr>{WEEKDAYS.map((w) => <th key={w.full} scope="col" abbr={w.full} className="pb-1 text-xs font-medium text-gray-600 dark:text-gray-400"><span aria-hidden="true">{w.short}</span><span className="sr-only">{w.full}</span></th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, row) => (
            <tr key={row}>
              {grid.slice(row * 7, row * 7 + 7).map((iso) => {
                const inMonth = ymOf(iso).month === view.month;
                const disabled = off(iso);
                const isSel = iso === selected;
                const label = formatDisplayDateWeekday(localDateFromISO(iso), '') ?? iso;
                return (
                  <td
                    key={iso}
                    role="gridcell"
                    data-iso={iso}
                    aria-label={label}
                    aria-selected={isSel}
                    aria-current={iso === today ? 'date' : undefined}
                    aria-disabled={disabled || undefined}
                    tabIndex={iso === focusIso ? 0 : -1}
                    onClick={() => { if (!disabled) onPick(iso); }}
                    onFocus={() => { grabFocus.current = true; if (iso !== focusIso) setFocusIso(iso); }}
                    className={cn(
                      cellSize, 'cursor-pointer rounded-md ff-focus-ring tabular-nums hover:bg-gray-100 dark:hover:bg-gray-700',
                      !inMonth && 'text-ink-muted',
                      iso === today && 'font-bold ring-1 ring-teal-500',
                      isSel && 'bg-teal-600 text-white hover:bg-teal-600 dark:bg-teal-600',
                      disabled && 'cursor-not-allowed opacity-40 line-through hover:bg-transparent',
                    )}
                  >
                    <span aria-hidden="true">{Number(iso.slice(8))}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={todayOff} onClick={() => onPick(today)} className="h-9 rounded-md border border-gray-300 px-3 text-sm ff-focus-ring disabled:opacity-40 dark:border-gray-600">Today</button>
        <button type="button" onClick={onClose} className="h-9 rounded-md px-3 text-sm text-gray-700 ff-focus-ring dark:text-gray-300">Close</button>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">{HINT}</p>
    </div>
  );

  return createPortal(
    sheet ? <><div aria-hidden="true" className="fixed inset-0 z-[69] bg-black/40" onClick={(e) => { e.stopPropagation(); onClose(); }} />{body}</> : body,
    document.body,
  );
}
