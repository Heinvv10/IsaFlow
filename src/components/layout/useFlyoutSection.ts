/**
 * Which section row of a nav panel has its sub-panel open (one at a time), for the top nav (ModuleNavMenus) and the
 * sidebar (SidebarFlyouts).
 *
 * Hover intent: a pointer that leaves an open row on its way to that row's sub-panel crosses the rows below it. A row
 * entered while the pointer is heading for the open sub-panel (`headsFor`) takes over only once the pointer has
 * stopped there for INTENT_MS or turned away, and not at all if it reaches the sub-panel first. Leaving the rows
 * altogether (off the last row, out of the menu) closes nothing while the pointer still heads for an open panel. Any
 * other entry (straight up or down the list) switches at once, so scanning the rows is not slowed down. Keyboard and
 * tap/click open at once, as before.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

export type Point = { x: number; y: number };
type Timer = { current: ReturnType<typeof setTimeout> | null };
type Box = { top: number; bottom: number; left: number; right: number };

/**
 * How long a row crossed on the way to the open sub-panel waits before it opens: the same 150 ms the panels already
 * allow a pointer outside them before they close. A pointer that stops on that row gets it after this delay.
 */
export const INTENT_MS = 150;
/** Vertical slack (px) around the sub-panel's edge, so aiming at its first or last link counts. */
const AIM_SLACK = 20;
/** Pointer positions kept; the oldest and newest give the direction, smoothing out single-pixel jitter. */
const TRAIL = 3;
const PANELS = '[data-nav-panel], [data-sidebar-flyout]';

/** Does the line from `from` through `to` reach the near vertical edge of `panel`, within its height? */
export function headsFor(from: Point, to: Point, panel: Box): boolean {
  const edge = from.x < panel.left ? panel.left : from.x > panel.right ? panel.right : null;
  const dx = to.x - from.x;
  if (edge === null || dx === 0 || Math.sign(dx) !== Math.sign(edge - from.x)) return false;
  const y = from.y + ((to.y - from.y) * (edge - from.x)) / dx;
  return y >= panel.top - AIM_SLACK && y <= panel.bottom + AIM_SLACK;
}

/**
 * While `active`, follows the pointer; `aimsAt` says whether it is heading for `panel` (see headsFor). `note` adds the
 * point where the pointer entered a row: a pointer that rested there and then moves once is still measured from it.
 * Shared by the section rows (useOpenSection) and the sidebar's tab rows (SidebarNav).
 */
export function usePointerAim(active: boolean) {
  const trail = useRef<Point[]>([]);
  const note = useCallback((p: Point) => { trail.current = [...trail.current.slice(1 - TRAIL), p]; }, []);
  useEffect(() => {
    if (!active) return undefined;
    const onMove = (e: MouseEvent) => note({ x: e.clientX, y: e.clientY });
    document.addEventListener('mousemove', onMove);
    return () => { document.removeEventListener('mousemove', onMove); trail.current = []; };
  }, [active, note]);
  const aimsAt = useCallback((panel: HTMLElement | null | undefined) => {
    const t = trail.current;
    return !!panel?.isConnected && t.length >= 2 && headsFor(t[0]!, t[t.length - 1]!, panel.getBoundingClientRect());
  }, []);
  /** Heading for any open fly-out panel: a close waits for that, however deep the panel is. */
  const aimsAtOpenPanel = useCallback(() => [...document.querySelectorAll<HTMLElement>(PANELS)].some(aimsAt), [aimsAt]);
  /**
   * Runs `then` in `ms`, unless by then the pointer has moved and `aimed()` still holds: then it waits again. A slow
   * but steady move toward a panel keeps it however long it spends on a crossed row or in the empty space before it.
   */
  const defer = useCallback((timer: Timer, aimed: () => boolean, then: () => void, ms = INTENT_MS) => {
    const wait = () => {
      const seen = trail.current[trail.current.length - 1];
      timer.current = setTimeout(() => {
        if (trail.current[trail.current.length - 1] !== seen && aimed()) wait();
        else then();
      }, ms);
    };
    wait();
  }, []);
  return { note, aimsAt, aimsAtOpenPanel, defer };
}

export function useOpenSection() {
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viaKeyboard = useRef(false);
  const openPanel = useRef<HTMLElement | null>(null);
  // The pointer's path matters only while a sub-panel is open.
  const aim = usePointerAim(open !== null);
  const cancel = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  useEffect(() => cancel, [cancel]);

  const show = (section: string, keyboard = false) => { cancel(); viaKeyboard.current = keyboard; setOpen(section); };

  return {
    open,
    cancel,
    /** True once if the open was keyboard-initiated, so focus moves into the panel. */
    takeKeyboardOpen: () => { const was = viaKeyboard.current; viaKeyboard.current = false; return was; },
    show,
    hide: () => { cancel(); setOpen(null); },
    later: () => { cancel(); aim.defer(timer, aim.aimsAtOpenPanel, () => setOpen(null), 150); },
    /** The open section's sub-panel registers itself, so `hover` can tell whether the pointer is heading for it. */
    register: (el: HTMLElement | null) => { openPanel.current = el; },
    /** The mouse entered a section row (or came back to the open one through its sub-panel) at `at`. */
    hover: (section: string, at: Point) => {
      aim.note(at);
      if (open !== null && open !== section && aim.aimsAt(openPanel.current)) {
        cancel();
        aim.defer(timer, () => aim.aimsAt(openPanel.current), () => show(section));
        return;
      }
      show(section);
    },
  };
}
export type OpenSection = ReturnType<typeof useOpenSection>;
