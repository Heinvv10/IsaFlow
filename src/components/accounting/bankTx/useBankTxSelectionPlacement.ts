/**
 * Placement of the Selection popover: fixed to the viewport (the grid's scroll box would clip an absolute one),
 * down unless there is less room below, and re-placed while the page or the window moves under it.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { placePanel, type PanelPlacement } from '@/components/ui/panelPlacement';

/** Search box + the 192px list + the "New ..." footer. */
const POPOVER_WANTED_HEIGHT = 300;

export function useBankTxSelectionPlacement(triggerRef: RefObject<HTMLElement>, open: boolean): (PanelPlacement & { left: number }) | null {
  const [place, setPlace] = useState<(PanelPlacement & { left: number }) | null>(null);
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // w-80 is 320px: pulled back inside the viewport rather than running off its right edge.
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - 320 - 8));
    setPlace({ ...placePanel(r, window.innerHeight, POPOVER_WANTED_HEIGHT), left });
  }, [triggerRef]);

  useEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [open, measure]);

  return place;
}
