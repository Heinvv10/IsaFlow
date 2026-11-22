/**
 * usePopupPanel — the shell shared by the date calendar and the month picker: a modal panel that is a bottom sheet
 * below lg (body scroll locked) and a popover under its field from lg up (placed with panelPlacement, following scroll
 * and resize once per frame). Traps focus (Escape closes and restores it), and closes on a press outside, except on the
 * button that opened it (that press is the button's own toggle).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { chooseSide, placePanel } from './panelPlacement';

const SHEET_QUERY = '(max-width: 1023.98px)';

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

export interface PopupPanelOptions {
  anchor: HTMLElement | null;
  trigger: HTMLElement | null;
  /** `restoreFocus` is true for Escape (focus goes back to the opener), false for an outside press. */
  onClose: (restoreFocus: boolean) => void;
  panelHeight: number;
  panelWidth: number;
}

export function usePopupPanel({ anchor, trigger, onClose, panelHeight, panelWidth }: PopupPanelOptions): {
  sheet: boolean; ref: RefObject<HTMLDivElement>; style: CSSProperties | undefined;
} {
  const sheet = useIsSheet();
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);

  useFocusTrap(ref, true, () => onClose(true));

  useEffect(() => {
    const down = (e: MouseEvent | TouchEvent): void => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || trigger?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('touchstart', down); };
  }, [trigger, onClose]);

  useLayoutEffect(() => {
    if (sheet || !anchor) { setStyle(undefined); return undefined; }
    let frame = 0;
    const place = (): void => {
      const r = anchor.getBoundingClientRect();
      const p = placePanel(r, window.innerHeight, chooseSide(r, window.innerHeight, panelHeight));
      setStyle({ position: 'fixed', left: Math.max(8, Math.min(r.left, window.innerWidth - panelWidth - 8)), top: p.top, bottom: p.bottom, maxHeight: p.maxHeight, width: panelWidth });
    };
    place();
    const follow = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; place(); });
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sheet, anchor, panelHeight, panelWidth]);

  // Only lock a body that is not already locked (a Modal or Drawer holds it), so the cleanup can never put back a stale 'hidden'.
  useEffect(() => {
    if (!sheet || document.body.style.overflow === 'hidden') return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [sheet]);

  return { sheet, ref, style };
}
