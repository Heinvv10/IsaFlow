/**
 * actionMenuParts — the pure layout and key rules of `ActionMenu`, and its isomorphic layout effect. Kept apart so
 * ActionMenu.tsx stays one component.
 */

import * as React from 'react';

/** One item's height (py-2, text-sm) and the menu's padding: the height the menu wants when it opens. */
export const ITEM_PX = 36;
export const MENU_PAD_PX = 8;
/** The viewport margin the menu keeps on both sides, and its narrowest width. */
export const EDGE_PX = 8;
export const MENU_MIN_W = 180;
/** A menu wider than the viewport is capped, so the left-aligned fallback still keeps the margin on the right. */
export const MENU_MAX_W = `calc(100vw - ${EDGE_PX * 2}px)`;

export interface MenuItemLike { disabled?: boolean }

export const enabledIndexes = (items: MenuItemLike[]): number[] => items.flatMap((it, i) => (it.disabled ? [] : [i]));

/**
 * Right-aligned to the trigger, but never past either edge of the viewport. `menuW` is the menu's measured width
 * (content-sized: a row menu is about 260px), never less than MENU_MIN_W.
 */
export function horizontal(r: DOMRect, menuW: number): { right?: number; left?: number } {
  const right = Math.max(EDGE_PX, window.innerWidth - r.right);
  return window.innerWidth - right - Math.max(MENU_MIN_W, menuW) < EDGE_PX ? { left: EDGE_PX } : { right };
}

/**
 * Where ArrowDown / ArrowUp go from the item at index `from` (-1: none). From none, ArrowDown goes to the first enabled
 * item and ArrowUp to the last; otherwise they move one enabled item on, wrapping.
 */
export function arrowTarget(enabled: number[], from: number, key: 'ArrowDown' | 'ArrowUp'): number | undefined {
  const n = enabled.length;
  if (n === 0) return undefined;
  const at = enabled.indexOf(from);
  if (at < 0) return key === 'ArrowDown' ? enabled[0] : enabled[n - 1];
  return enabled[(at + (key === 'ArrowDown' ? 1 : -1) + n) % n];
}

/** useLayoutEffect in the browser, useEffect on the server (where a layout effect cannot run and React warns). */
export const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;
